import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AuditService } from '@agentbridge/audit';
import { CollaborationService } from '@agentbridge/collaboration';
import { ClaudeConnector, CodexAutoConnector } from '@agentbridge/connectors';
import {
  ensureProjectMetadata,
  registerProject,
  Storage,
} from '@agentbridge/storage';
import type { AgentType } from '@agentbridge/protocol';
import { runDynamicServer, type MCPRuntime } from './server.js';
import { readOptionalBoundedInteger } from './runtimeConfig.js';

const agentType: AgentType = process.env.AGENTBRIDGE_AGENT === 'codex' ? 'codex' : 'claude';
let runtimePromise: Promise<MCPRuntime> | null = null;
let boundProjectPath: string | null = null;
let activeStorage: Storage | null = null;
let activeCollaboration: CollaborationService | null = null;

async function resolveRuntime(requestedProjectPath: string | undefined, server: Server): Promise<MCPRuntime> {
  if (!requestedProjectPath && boundProjectPath && runtimePromise) return runtimePromise;
  const projectPath = await detectProjectPath(requestedProjectPath, server);
  if (boundProjectPath && !samePath(boundProjectPath, projectPath)) {
    throw new Error(`This MCP session is already bound to ${boundProjectPath}; open/switch the client project to use ${projectPath}`);
  }
  boundProjectPath = projectPath;
  runtimePromise ??= createRuntime(projectPath);
  return runtimePromise;
}

async function createRuntime(projectPath: string): Promise<MCPRuntime> {
  ensureProjectMetadata(projectPath);
  registerProject({
    projectPath,
    claudeConfig: process.env.AGENTBRIDGE_CLAUDE_CONFIG ?? join(homedir(), '.claude.json'),
    codexConfig: process.env.AGENTBRIDGE_CODEX_CONFIG ?? join(homedir(), '.codex', 'config.toml'),
    scope: 'global',
  });
  const storage = new Storage(process.env.AGENTBRIDGE_DB_PATH ?? join(projectPath, '.agentbridge', 'agentbridge.sqlite'));
  activeStorage = storage;
  const audit = new AuditService(storage);
  storage.recoverExpiredSessionLeases();
  storage.pruneSessions(readBoundedInteger('AGENTBRIDGE_SESSION_PRUNE_MAX_AGE_MS', 30 * 24 * 60 * 60 * 1_000, 1_000, 365 * 24 * 60 * 60 * 1_000));
  const timeoutMs = readBoundedInteger('AGENTBRIDGE_TIMEOUT_MS', 120_000, 1_000, 600_000);
  const startupTimeoutMs = readBoundedInteger('AGENTBRIDGE_STARTUP_TIMEOUT_MS', 15_000, 1_000, 600_000);
  const maxDurationMs = readBoundedInteger('AGENTBRIDGE_MAX_DURATION_MS', 30 * 60 * 1_000, 1_000, 7 * 24 * 60 * 60 * 1_000);
  const maxTurns = readOptionalBoundedInteger('AGENTBRIDGE_MAX_TURNS', 1, 50);
  const retentionDays = readBoundedInteger('AGENTBRIDGE_DISCUSSION_RETENTION_DAYS', 0, 0, 3650);
  if (retentionDays > 0) {
    const cleanup = storage.cleanupDiscussions(retentionDays, true);
    audit.log({
      traceId: `tr_cleanup_${Date.now()}`,
      discussionId: null,
      action: 'storage.cleanup',
      agent: 'system',
      metadata: cleanup,
    });
  }
  const recoveryAgeMs = Number.parseInt(process.env.AGENTBRIDGE_RECOVERY_MAX_AGE_MS ?? '', 10);
  const recovered = storage.recoverStaleDiscussions(
    Number.isInteger(recoveryAgeMs) && recoveryAgeMs > 0 ? recoveryAgeMs : undefined,
  );
  for (const discussion of recovered) {
    audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.recovered',
      agent: 'system',
      metadata: { status: discussion.status, reason: 'stale_process_recovery' },
    });
  }
  const collaboration = new CollaborationService(
    storage,
    audit,
    {
      maxTurns,
      timeoutMs,
      maxDurationMs,
      asyncDispatch: readBoolean('AGENTBRIDGE_ASYNC_DISPATCH', true),
      archiveSessionsOnClose: readBoolean('AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE', false),
    },
    {
      claude: new ClaudeConnector({ command: process.env.AGENTBRIDGE_CLAUDE_COMMAND, timeoutMs }),
      codex: new CodexAutoConnector({
        model: process.env.AGENTBRIDGE_CODEX_MODEL,
        timeoutMs,
        startupTimeoutMs,
      }),
    },
  );
  activeCollaboration = collaboration;
  return { storage, collaboration, projectPath };
}

function readBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const normalized = raw.trim();
  const value = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value`);
}

async function detectProjectPath(requestedProjectPath: string | undefined, server: Server): Promise<string> {
  const authoritative = [
    requestedProjectPath,
    process.env.AGENTBRIDGE_PROJECT_PATH,
    process.env.CLAUDE_PROJECT_DIR,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (authoritative) return validateProjectPath(authoritative);

  if (server.getClientCapabilities()?.roots) {
    try {
      const result = await server.listRoots();
      for (const root of result.roots) {
        if (!root.uri.startsWith('file:')) continue;
        const candidate = validateProjectPath(fileURLToPath(root.uri));
        if (candidate) return candidate;
      }
    } catch {
      // A roots-capable host may still reject the optional request; fall back to cwd.
    }
  }

  const cwd = validateProjectPath(process.cwd());
  if (isUnsafeImplicitPath(cwd)) {
    throw new Error(
      'AgentBridge could not determine the active project safely. Open a project/workspace in Claude Code or Codex, '
      + 'or pass projectPath to ask_peer/list_discussions. No database was created.',
    );
  }
  return cwd;
}

function validateProjectPath(value: string): string {
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Project directory does not exist: ${path}`);
  return path;
}

function isUnsafeImplicitPath(path: string): boolean {
  const roots = [parse(path).root, homedir(), process.env.AGENTBRIDGE_INSTALL_ROOT]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value));
  return roots.some((value) => samePath(value, path)) || samePath(dirname(process.execPath), path);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownPromise = (async () => {
    try {
      await activeCollaboration?.shutdown(5_000);
    } finally {
      activeStorage?.close();
      process.exit(0);
    }
  })();
  void shutdownPromise;
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const testLifetimeMs = Number.parseInt(process.env.AGENTBRIDGE_TEST_MAX_LIFETIME_MS ?? '', 10);
if (Number.isInteger(testLifetimeMs) && testLifetimeMs > 0) setTimeout(shutdown, testLifetimeMs);

if (process.env.AGENTBRIDGE_BASELINE_FILE) {
  writeFileSync(process.env.AGENTBRIDGE_BASELINE_FILE, JSON.stringify({
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    node: process.versions.node,
  }));
  shutdown();
}

const exitAfterToolCalls = Number.parseInt(process.env.AGENTBRIDGE_TEST_EXIT_AFTER_TOOL_CALLS ?? '', 10);
await runDynamicServer(resolveRuntime, {
  agentType,
  ...(Number.isInteger(exitAfterToolCalls) && exitAfterToolCalls > 0 ? { exitAfterToolCalls } : {}),
});
