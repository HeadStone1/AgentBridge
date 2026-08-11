import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const mcpEntry = fileURLToPath(new URL('../../packages/mcp/dist/cli.js', import.meta.url));
const repoRoot = resolve(mcpEntry, '..', '..', '..');
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
process.once('exit', () => {
  for (const child of activeChildren) child.kill();
});
process.once('SIGINT', () => {
  for (const child of activeChildren) child.kill();
});
process.once('SIGTERM', () => {
  for (const child of activeChildren) child.kill();
});

afterAll(async () => {
  await Promise.all([...activeChildren].map((child) => stopChild(child)));
});

describe('dual stdio MCP processes', () => {
  it('shares one SQLite discussion across independent MCP server processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbridge-stdio-'));
    const dbPath = join(directory, 'shared.sqlite');
    const claude = startMcp('claude', dbPath, 1);
    const codex = startMcp('codex', dbPath, 2);

    try {
      await initialize(claude, 'claude-client');
      await initialize(codex, 'codex-client');

      const failedAsk = await callTool(claude, 2, 'ask_peer', {
        peer: 'codex',
        message: 'cross-process persistence check',
        projectPath: directory,
      });
      expect(failedAsk.isError).toBe(true);

      const listed = await callTool(codex, 2, 'list_discussions', { projectPath: directory });
      const listedPayload = JSON.parse(listed.content[0].text) as { discussions: Array<{ id: string; status: string; currentTurn: number }> };
      const discussion = listedPayload.discussions[0];
      expect(discussion).toBeDefined();
      expect(discussion.currentTurn).toBe(1);

      const read = await callTool(codex, 3, 'get_discussion', { discussionId: discussion.id });
      expect(read.isError).not.toBe(true);
      const payload = JSON.parse(read.content[0].text) as { discussion: { id: string; status: string }; messages: unknown[] };
      expect(payload.discussion).toMatchObject({ id: discussion.id, status: 'PEER_BUSY' });
      expect(payload.messages).toHaveLength(1);
    } finally {
      await Promise.all([stopChild(claude), stopChild(codex)]);
      await delay(100);
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 30_000);
});

function startMcp(agent: 'claude' | 'codex', dbPath: string, exitAfterToolCalls: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [mcpEntry], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      AGENTBRIDGE_AGENT: agent,
      AGENTBRIDGE_DB_PATH: dbPath,
      AGENTBRIDGE_CLAUDE_COMMAND: '__agentbridge_missing_claude__',
      AGENTBRIDGE_CODEX_COMMAND: '__agentbridge_missing_codex__',
      AGENTBRIDGE_ASYNC_DISPATCH: '0',
      AGENTBRIDGE_TEST_EXIT_AFTER_TOOL_CALLS: String(exitAfterToolCalls),
      AGENTBRIDGE_TEST_MAX_LIFETIME_MS: '12000',
    },
  });
  const stderr: string[] = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.join('').length > 4_000) stderr.splice(0, stderr.length - 1);
  });
  (child as ChildProcessWithoutNullStreams & { agentbridgeStderr?: () => string }).agentbridgeStderr = () => stderr.join('').trim();
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  return child;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.stdin.destroyed) child.stdin.end();
  const closed = await waitForClose(child, 3_000);
  if (closed) return;
  child.kill();
  await waitForClose(child, 5_000);
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initialize(child: ChildProcessWithoutNullStreams, clientName: string): Promise<void> {
  await request(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    },
  }, 15_000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
}

async function callTool(child: ChildProcessWithoutNullStreams, id: number, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await request(child, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return response.result;
}

function request(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      const stderr = (child as ChildProcessWithoutNullStreams & { agentbridgeStderr?: () => string }).agentbridgeStderr?.() ?? '';
      reject(new Error(`MCP request timed out: ${String(message.method)}; exit=${child.exitCode ?? 'running'}; stderr=${stderr}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.id !== message.id) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
        else resolve(parsed);
        return;
      }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}
