import { spawn } from 'node:child_process';
import type { AgentConnector, PeerResponse } from './index.js';
import { ProviderError } from '@agentbridge/protocol';
import type { Message, PeerActivity, PeerPermissionRequestInput, PermissionDecision } from '@agentbridge/protocol';
import { buildPeerPrompt } from './prompt.js';

export interface CodexConnectorOptions {
  /** Executable path or command name. No shell parsing is performed. */
  command?: string;
  /** Legacy alias for the absolute provider hard limit. */
  timeoutMs?: number;
  hardTimeoutMs?: number;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  skipGitRepoCheck?: boolean;
  ignoreRules?: boolean;
  extraArgs?: string[];
}

/**
 * Codex CLI adapter.
 *
 * Codex exposes a stable non-interactive interface through `codex exec` and
 * `codex exec resume`. The persistent collaboration layer supplies the
 * returned thread id across MCP restarts. This adapter parses the JSONL event
 * stream without invoking a shell or enabling approval/sandbox bypasses.
 */
export class CodexConnector implements AgentConnector {
  readonly agentType = 'codex' as const;
  private readonly command: string;
  private readonly hardTimeoutMs: number;
  private readonly model?: string;
  private readonly sandbox: NonNullable<CodexConnectorOptions['sandbox']>;
  private readonly skipGitRepoCheck: boolean;
  private readonly ignoreRules: boolean;
  private readonly extraArgs: string[];

  constructor(options: CodexConnectorOptions = {}) {
    this.command = options.command ?? process.env.AGENTBRIDGE_CODEX_COMMAND ?? process.env.CODEX_CLI_PATH ?? 'codex';
    this.hardTimeoutMs = options.hardTimeoutMs ?? options.timeoutMs ?? 30 * 60 * 1_000;
    this.model = options.model ?? process.env.AGENTBRIDGE_CODEX_MODEL;
    this.sandbox = options.sandbox ?? 'read-only';
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
    this.ignoreRules = options.ignoreRules ?? false;
    this.extraArgs = options.extraArgs ?? [];

    if (!this.command.trim()) throw new Error('Codex connector command must not be empty');
    if (!Number.isInteger(this.hardTimeoutMs) || this.hardTimeoutMs < 1_000 || this.hardTimeoutMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('Codex connector hardTimeoutMs must be an integer between 1000 and 604800000');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await runProcess(this.command, ['--version'], process.cwd(), 15_000);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async isBusy(): Promise<boolean> {
    // CollaborationService owns the provider/project SessionLease. The CLI
    // does not expose a reliable cross-process busy query.
    return false;
  }

  async sendAndWait(context: {
    projectPath: string;
    prompt: string;
    discussionId: string;
    previousMessages?: Message[];
    providerSessionId?: string;
    providerSessionKind?: 'claude-cli' | 'codex-cli' | 'codex-app-server';
    signal?: AbortSignal;
    onActivity?: (activity: PeerActivity) => void;
    onPermissionRequest?: (request: PeerPermissionRequestInput) => Promise<PermissionDecision>;
  }): Promise<PeerResponse> {
    const started = Date.now();
    context.onActivity?.({ kind: 'turn_started', at: started, processAlive: true, connectionAlive: true });
    const canResume = Boolean(context.providerSessionId)
      && (!context.providerSessionKind || context.providerSessionKind === 'codex-cli');
    let existingThread = canResume ? context.providerSessionId : undefined;
    let prompt = buildPeerPrompt(context.prompt, existingThread ? [] : context.previousMessages ?? []);
    let result = await runProcess(
      this.command,
      [...this.buildArgs(existingThread), prompt],
      context.projectPath,
      this.hardTimeoutMs,
      context.signal,
      context.onActivity,
    );

    if (result.exitCode !== 0 && existingThread && isSessionLost(result)) {
      existingThread = undefined;
      prompt = buildPeerPrompt(context.prompt, context.previousMessages ?? []);
      result = await runProcess(
        this.command,
        [...this.buildArgs(), prompt],
        context.projectPath,
        this.hardTimeoutMs,
        context.signal,
        context.onActivity,
      );
    }

    if (result.exitCode !== 0) {
      throw new ProviderError('FAILED', `Codex CLI failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim());
    }

    const parsed = parseCodexOutput(result.stdout);
    const threadId = parsed.threadId ?? existingThread;
    if (!threadId) {
      throw new Error('Codex CLI did not return a thread id in its JSONL output');
    }
    context.onActivity?.({ kind: 'turn_completed', at: Date.now(), processAlive: false, connectionAlive: false });
    return {
      content: parsed.content,
      duration: Date.now() - started,
      providerSessionId: threadId,
      providerSessionKind: 'codex-cli',
      availability: 'BACKGROUND',
    };
  }

  async getAvailability(): Promise<'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE'> {
    return (await this.isAvailable()) ? 'BACKGROUND' : 'UNAVAILABLE';
  }

  private buildArgs(existingThread?: string): string[] {
    const args = [
      ...this.extraArgs,
      'exec',
      '--json',
      '--sandbox',
      this.sandbox,
      ...(this.skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
      ...(this.ignoreRules ? ['--ignore-rules'] : []),
      ...(this.model ? ['--model', this.model] : []),
      '--color',
      'never',
      ...(existingThread ? ['resume', existingThread] : []),
    ];
    return args;
  }
}

function parseCodexOutput(stdout: string): { content: string; threadId?: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('Codex CLI returned an empty response');

  let threadId: string | undefined;
  const messages: string[] = [];
  const rawEvents: unknown[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      rawEvents.push(event);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id;
      }

      const item = isRecord(event.item) ? event.item : event;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        messages.push(item.text);
      }
    } catch {
      // Keep non-JSON lines as a fallback only; normal --json output is JSONL.
    }
  }

  if (messages.length > 0) return { content: messages[messages.length - 1], threadId };

  const finalEvent = rawEvents.at(-1);
  if (isRecord(finalEvent)) {
    for (const key of ['result', 'response', 'text', 'message']) {
      if (typeof finalEvent[key] === 'string') {
        return { content: finalEvent[key], threadId };
      }
    }
  }

  throw new Error(`Codex CLI returned no agent message: ${stdout.slice(0, 1000)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onActivity?: (activity: PeerActivity) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, AGENTBRIDGE_PEER_INVOCATION: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let termination: { code: 'CANCELLED' | 'TIMEOUT'; message: string } | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const terminate = (reason: { code: 'CANCELLED' | 'TIMEOUT'; message: string }) => {
      if (settled || termination) return;
      termination = reason;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch { /* close/error will settle the operation */ }
      forceKillTimer = setTimeout(() => {
        if (!settled && child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch { /* close/error will report failure */ }
        }
      }, 2_000);
    };
    const onAbort = () => terminate({ code: 'CANCELLED', message: 'Codex CLI request was cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });

    onActivity?.({ kind: 'process_started', at: Date.now(), processAlive: true, connectionAlive: true });
    heartbeat = setInterval(() => {
      if (!settled && child.exitCode === null) {
        onActivity?.({ kind: 'process_heartbeat', at: Date.now(), processAlive: true, connectionAlive: true });
      }
    }, 1_000);
    heartbeat.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      onActivity?.({ kind: 'output', at: Date.now(), processAlive: true, connectionAlive: true });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      onActivity?.({ kind: 'provider_event', at: Date.now(), processAlive: true, connectionAlive: true });
    });
    child.once('error', (error) => {
      const failure = termination
        ? new ProviderError(termination.code, termination.message, { cause: error })
        : new ProviderError('UNAVAILABLE', `Codex CLI could not start: ${error.message}`, { cause: error });
      finish(() => reject(failure));
    });
    child.once('close', (exitCode) => {
      onActivity?.({ kind: 'process_exited', at: Date.now(), processAlive: false, connectionAlive: false, detail: String(exitCode ?? '') });
      if (termination) {
        finish(() => reject(new ProviderError(termination!.code, termination!.message)));
      } else {
        finish(() => resolve({ exitCode, stdout, stderr }));
      }
    });
    if (signal?.aborted) onAbort();
    if (!termination) {
      timer = setTimeout(() => terminate({
        code: 'TIMEOUT',
        message: `Codex CLI timed out after ${timeoutMs}ms`,
      }), timeoutMs);
    }
  });
}

function isSessionLost(result: ProcessResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /thread[_ -]?(not found|missing|lost|expired|invalid)|session[_ -]?(not found|missing|lost|expired|invalid)|unknown (thread|session)|session_corrupted/.test(output);
}
