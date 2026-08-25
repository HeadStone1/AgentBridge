import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentConnector, PeerResponse } from './index.js';
import { ProviderError } from '@agentbridge/protocol';
import type { Message, PeerActivity, PeerPermissionRequestInput, PermissionDecision } from '@agentbridge/protocol';
import { buildPeerPrompt } from './prompt.js';

export interface ClaudeConnectorOptions {
  command?: string;
  /** Legacy alias for the absolute provider hard limit. */
  timeoutMs?: number;
  hardTimeoutMs?: number;
  extraArgs?: string[];
}

/**
 * Claude Code CLI adapter.
 *
 * The adapter deliberately runs Claude in print/plan mode and never enables
 * permission bypasses. Session IDs are supplied by the persistent
 * collaboration layer so conversations survive MCP process restarts.
 */
export class ClaudeConnector implements AgentConnector {
  readonly agentType = 'claude' as const;
  private readonly command: string;
  private hardTimeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: ClaudeConnectorOptions = {}) {
    this.command = options.command ?? 'claude';
    this.hardTimeoutMs = options.hardTimeoutMs ?? options.timeoutMs ?? 30 * 60 * 1_000;
    this.extraArgs = options.extraArgs ?? [];
    if (!Number.isInteger(this.hardTimeoutMs) || this.hardTimeoutMs < 1_000 || this.hardTimeoutMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new Error('Claude connector hardTimeoutMs must be an integer between 1000 and 31536000000');
    }
  }

  updateLimits(limits: { hardTimeoutMs: number }): void {
    if (!Number.isSafeInteger(limits.hardTimeoutMs) || limits.hardTimeoutMs < 1_000 || limits.hardTimeoutMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new Error('Claude connector hardTimeoutMs must be between 1000 and 31536000000');
    }
    this.hardTimeoutMs = limits.hardTimeoutMs;
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
    // CollaborationService owns the provider/project SessionLease. Claude CLI
    // does not expose a reliable cross-process busy query through --help.
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
      && (!context.providerSessionKind || context.providerSessionKind === 'claude-cli');
    let sessionId = canResume ? context.providerSessionId! : randomUUID();
    let resumed = canResume;
    let prompt = buildPeerPrompt(context.prompt, resumed ? [] : context.previousMessages ?? []);
    let result = await runProcess(
      this.command,
      [...this.buildArgs(sessionId, resumed), prompt],
      context.projectPath,
      this.hardTimeoutMs,
      context.signal,
      context.onActivity,
    );

    // Provider-side sessions can be deleted independently. Rebuild a fresh
    // session from SQLite history instead of losing the discussion.
    if (result.exitCode !== 0 && resumed && isSessionLost(result)) {
      sessionId = randomUUID();
      resumed = false;
      prompt = buildPeerPrompt(context.prompt, context.previousMessages ?? []);
      result = await runProcess(
        this.command,
        [...this.buildArgs(sessionId, false), prompt],
        context.projectPath,
        this.hardTimeoutMs,
        context.signal,
        context.onActivity,
      );
    }
    if (result.exitCode !== 0) {
      throw new ProviderError('FAILED', `Claude CLI failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim());
    }

    const parsed = parseClaudeOutput(result.stdout);
    const providerSessionId = parsed.sessionId ?? sessionId;
    context.onActivity?.({ kind: 'turn_completed', at: Date.now(), processAlive: false, connectionAlive: false });
    return {
      content: parsed.content,
      duration: Date.now() - started,
      providerSessionId,
      providerSessionKind: 'claude-cli',
      availability: 'BACKGROUND',
    };
  }

  async getAvailability(): Promise<'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE'> {
    return (await this.isAvailable()) ? 'BACKGROUND' : 'UNAVAILABLE';
  }

  private buildArgs(sessionId: string, resume: boolean): string[] {
    return [
      ...this.extraArgs,
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ];
  }
}

function parseClaudeOutput(stdout: string): { content: string; sessionId?: string } {
  const raw = stdout.trim();
  if (!raw) throw new Error('Claude CLI returned an empty response');

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const content = typeof value.result === 'string'
      ? value.result
      : typeof value.response === 'string'
        ? value.response
        : Array.isArray(value.content)
          ? value.content.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
          : raw;
    const sessionId = typeof value.session_id === 'string'
      ? value.session_id
      : typeof value.sessionId === 'string'
        ? value.sessionId
        : undefined;
    return { content, sessionId };
  } catch {
    return { content: raw };
  }
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
    const onAbort = () => terminate({ code: 'CANCELLED', message: 'Claude CLI request was cancelled' });
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
        : new ProviderError('UNAVAILABLE', `Claude CLI could not start: ${error.message}`, { cause: error });
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
        message: `Claude CLI timed out after ${timeoutMs}ms`,
      }), timeoutMs);
    }
  });
}

function isSessionLost(result: ProcessResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /session[_ -]?(not found|missing|lost|expired|invalid)|unknown session|session_corrupted/.test(output);
}
