import { spawn } from 'node:child_process';
import type { AgentConnector, PeerResponse } from './index.js';
import type { Message } from '@agentbridge/protocol';
import { buildPeerPrompt } from './prompt.js';

export interface CodexConnectorOptions {
  /** Executable path or command name. No shell parsing is performed. */
  command?: string;
  timeoutMs?: number;
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
  private readonly timeoutMs: number;
  private readonly model?: string;
  private readonly sandbox: NonNullable<CodexConnectorOptions['sandbox']>;
  private readonly skipGitRepoCheck: boolean;
  private readonly ignoreRules: boolean;
  private readonly extraArgs: string[];

  constructor(options: CodexConnectorOptions = {}) {
    this.command = options.command ?? process.env.AGENTBRIDGE_CODEX_COMMAND ?? process.env.CODEX_CLI_PATH ?? 'codex';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.model = options.model ?? process.env.AGENTBRIDGE_CODEX_MODEL;
    this.sandbox = options.sandbox ?? 'read-only';
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
    this.ignoreRules = options.ignoreRules ?? false;
    this.extraArgs = options.extraArgs ?? [];

    if (!this.command.trim()) throw new Error('Codex connector command must not be empty');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 600_000) {
      throw new Error('Codex connector timeoutMs must be an integer between 1000 and 600000');
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
  }): Promise<PeerResponse> {
    const started = Date.now();
    const canResume = Boolean(context.providerSessionId)
      && (!context.providerSessionKind || context.providerSessionKind === 'codex-cli');
    let existingThread = canResume ? context.providerSessionId : undefined;
    let prompt = buildPeerPrompt(context.prompt, existingThread ? [] : context.previousMessages ?? []);
    let result = await runProcess(
      this.command,
      [...this.buildArgs(existingThread), prompt],
      context.projectPath,
      this.timeoutMs,
    );

    if (result.exitCode !== 0 && existingThread) {
      existingThread = undefined;
      prompt = buildPeerPrompt(context.prompt, context.previousMessages ?? []);
      result = await runProcess(
        this.command,
        [...this.buildArgs(), prompt],
        context.projectPath,
        this.timeoutMs,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(`Codex CLI failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim());
    }

    const parsed = parseCodexOutput(result.stdout);
    const threadId = parsed.threadId ?? existingThread;
    if (!threadId) {
      throw new Error('Codex CLI did not return a thread id in its JSONL output');
    }
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
