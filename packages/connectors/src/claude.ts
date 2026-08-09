import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentConnector, PeerResponse } from './index.js';
import type { Message } from '@agentbridge/protocol';
import { buildPeerPrompt } from './prompt.js';

export interface ClaudeConnectorOptions {
  command?: string;
  timeoutMs?: number;
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
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: ClaudeConnectorOptions = {}) {
    this.command = options.command ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.extraArgs = options.extraArgs ?? [];
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 600_000) {
      throw new Error('Claude connector timeoutMs must be an integer between 1000 and 600000');
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
  }): Promise<PeerResponse> {
    const started = Date.now();
    const canResume = Boolean(context.providerSessionId)
      && (!context.providerSessionKind || context.providerSessionKind === 'claude-cli');
    let sessionId = canResume ? context.providerSessionId! : randomUUID();
    let resumed = canResume;
    let prompt = buildPeerPrompt(context.prompt, resumed ? [] : context.previousMessages ?? []);
    let result = await runProcess(
      this.command,
      [...this.buildArgs(sessionId, resumed), prompt],
      context.projectPath,
      this.timeoutMs,
    );

    // Provider-side sessions can be deleted independently. Rebuild a fresh
    // session from SQLite history instead of losing the discussion.
    if (result.exitCode !== 0 && resumed) {
      sessionId = randomUUID();
      resumed = false;
      prompt = buildPeerPrompt(context.prompt, context.previousMessages ?? []);
      result = await runProcess(
        this.command,
        [...this.buildArgs(sessionId, false), prompt],
        context.projectPath,
        this.timeoutMs,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(`Claude CLI failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim());
    }

    const parsed = parseClaudeOutput(result.stdout);
    const providerSessionId = parsed.sessionId ?? sessionId;
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

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}
