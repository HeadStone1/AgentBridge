import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AuditService } from '@agentbridge/audit';
import { resolveConfig } from '@agentbridge/config';
import { CollaborationService } from '@agentbridge/collaboration';
import { ClaudeConnector, CodexAutoConnector } from '@agentbridge/connectors';
import {
  ensureProjectMetadata,
  registerProject,
  Storage,
} from '@agentbridge/storage';
import type { AgentType } from '@agentbridge/protocol';
import { runDynamicServer, type MCPRuntime } from './server.js';

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
  const effective = resolveConfig(projectPath);
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
  storage.pruneSessions(effective.config.session.pruneMaxAgeMs);
  const { discussion, session } = effective.config;
  const retentionDays = session.retentionDays;
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
  const recovered = storage.recoverStaleDiscussions(
    session.recoveryMaxAgeMs,
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
      maxTurns: discussion.maxTurns,
      idleTimeoutMs: discussion.idleTimeoutMs,
      startupTimeoutMs: discussion.startupTimeoutMs,
      stallGraceMs: discussion.stallGraceMs,
      turnHardLimitMs: discussion.turnHardLimitMs,
      maxDurationMs: discussion.maxDurationMs,
      timeoutMs: discussion.leaseTimeoutMs,
      terminationGraceMs: discussion.terminationGraceMs,
      maxTotalMessageChars: discussion.maxTotalMessageChars,
      archiveSessionsOnClose: session.archiveOnClose,
    },
    {
      claude: new ClaudeConnector({ command: process.env.AGENTBRIDGE_CLAUDE_COMMAND, hardTimeoutMs: discussion.turnHardLimitMs }),
      codex: new CodexAutoConnector({
        model: process.env.AGENTBRIDGE_CODEX_MODEL,
        hardTimeoutMs: discussion.turnHardLimitMs,
        startupTimeoutMs: discussion.startupTimeoutMs,
      }),
    },
  );
  activeCollaboration = collaboration;
  return {
    storage,
    collaboration,
    projectPath,
    refreshConfig: () => {
      const next = resolveConfig(projectPath);
      collaboration.updateConfig({
        maxTurns: next.config.discussion.maxTurns,
        timeoutMs: next.config.discussion.leaseTimeoutMs,
        idleTimeoutMs: next.config.discussion.idleTimeoutMs,
        startupTimeoutMs: next.config.discussion.startupTimeoutMs,
        stallGraceMs: next.config.discussion.stallGraceMs,
        turnHardLimitMs: next.config.discussion.turnHardLimitMs,
        maxDurationMs: next.config.discussion.maxDurationMs,
        terminationGraceMs: next.config.discussion.terminationGraceMs,
        maxTotalMessageChars: next.config.discussion.maxTotalMessageChars,
        archiveSessionsOnClose: next.config.session.archiveOnClose,
      });
      return next;
    },
  };
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
