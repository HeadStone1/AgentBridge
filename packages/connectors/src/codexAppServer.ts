import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  Message,
  PeerActivity,
  PeerPermissionRequestInput,
  PermissionDecision,
} from '@agentbridge/protocol';
import { ProviderError, isProviderError } from '@agentbridge/protocol';
import type { AgentConnector, PeerResponse } from './index.js';
import { buildPeerPrompt } from './prompt.js';
import { HeadlessPeerPolicy } from './policy.js';

export interface CodexAppServerConnectorOptions {
  /** App executable or wrapper that supports `app-server` over stdio. */
  command?: string;
  /** Arguments placed before the App Server subcommand (useful for node fixtures/wrappers). */
  serverArgs?: string[];
  /** Legacy alias for the absolute provider hard limit. */
  timeoutMs?: number;
  hardTimeoutMs?: number;
  startupTimeoutMs?: number;
  model?: string;
  stderrBufferBytes?: number;
}

type JsonObject = Record<string, unknown>;

/**
 * Codex App Server adapter.
 *
 * This starts one bounded stdio App Server child per MCP process when an
 * explicit command is configured. It does not inspect or inject into the
 * already-running Desktop App process.
 */
export class CodexAppServerConnector implements AgentConnector {
  readonly agentType = 'codex' as const;
  private readonly command: string;
  private readonly serverArgs: string[];
  private readonly hardTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly model?: string;
  private readonly stderrBufferBytes: number;
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  private readonly events: JsonObject[] = [];
  private readonly eventWaiters: Array<(event: JsonObject) => void> = [];
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextRequestId = 1;
  private initialized = false;
  private inFlight = false;
  private serial: Promise<void> = Promise.resolve();
  private availability?: Promise<boolean>;
  private stderrTail = '';
  private readonly activeTurns = new Map<string, { threadId: string; turnId?: string }>();
  private activeActivity?: (activity: PeerActivity) => void;
  private activePermissionRequest?: (request: PeerPermissionRequestInput) => Promise<PermissionDecision>;
  private activePolicy?: HeadlessPeerPolicy;
  private activeDiscussionId?: string;
  private activeDispatchId?: string;
  private processHeartbeat?: ReturnType<typeof setInterval>;

  constructor(options: CodexAppServerConnectorOptions = {}) {
    this.command = options.command ?? process.env.AGENTBRIDGE_CODEX_APP_COMMAND ?? '';
    this.serverArgs = options.serverArgs ?? [];
    this.hardTimeoutMs = options.hardTimeoutMs ?? options.timeoutMs ?? 30 * 60 * 1_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.model = options.model;
    this.stderrBufferBytes = options.stderrBufferBytes ?? 256 * 1024;
    if (!Number.isInteger(this.hardTimeoutMs) || this.hardTimeoutMs < 1_000 || this.hardTimeoutMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('Codex App Server hardTimeoutMs must be an integer between 1000 and 604800000');
    }
    if (!Number.isInteger(this.startupTimeoutMs) || this.startupTimeoutMs < 1_000 || this.startupTimeoutMs > 600_000) {
      throw new Error('Codex App Server startupTimeoutMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.stderrBufferBytes) || this.stderrBufferBytes < 4_096 || this.stderrBufferBytes > 1_024 * 1_024) {
      throw new Error('Codex App Server stderrBufferBytes must be between 4096 and 1048576');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.command.trim()) return false;
    this.availability ??= this.ensureServer().then(() => true).catch(() => {
      this.closeServer();
      this.availability = undefined;
      return false;
    });
    return this.availability;
  }

  async getAvailability(): Promise<'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE'> {
    return (await this.isAvailable()) ? 'BACKGROUND' : 'UNAVAILABLE';
  }

  async isBusy(): Promise<boolean> {
    return this.inFlight;
  }

  async sendAndWait(context: {
    projectPath: string;
    prompt: string;
    discussionId: string;
    dispatchId?: string;
    previousMessages?: Message[];
    providerSessionId?: string;
    providerSessionKind?: 'claude-cli' | 'codex-cli' | 'codex-app-server';
    signal?: AbortSignal;
    onActivity?: (activity: PeerActivity) => void;
    onPermissionRequest?: (request: PeerPermissionRequestInput) => Promise<PermissionDecision>;
  }): Promise<PeerResponse> {
    return this.runSerial(async () => {
      if (!this.command.trim()) {
        throw new Error('Codex App Server command is not configured; set AGENTBRIDGE_CODEX_APP_COMMAND');
      }
      this.activeActivity = context.onActivity;
      this.activePermissionRequest = context.onPermissionRequest;
      this.activePolicy = new HeadlessPeerPolicy(context.projectPath);
      this.activeDiscussionId = context.discussionId;
      this.activeDispatchId = context.dispatchId;
      try {
        await this.ensureServer();
      } catch (error) {
        this.activeActivity = undefined;
        this.activePermissionRequest = undefined;
        this.activePolicy = undefined;
        this.activeDiscussionId = undefined;
        this.activeDispatchId = undefined;
        throw error;
      }
      const started = Date.now();
      this.inFlight = true;
      let turnStarted = false;
      try {
        const canResume = Boolean(context.providerSessionId)
          && (!context.providerSessionKind || context.providerSessionKind === 'codex-app-server');
        let threadId = canResume ? context.providerSessionId! : undefined;
        let resumed = false;
        if (threadId) {
          try {
            await this.request('thread/resume', { threadId, cwd: context.projectPath }, this.startupTimeoutMs);
            resumed = true;
          } catch (error) {
            if (!isSessionLostError(error)) throw error;
            threadId = undefined;
          }
        }
        threadId ??= await this.startThread(context.projectPath);

        this.activeTurns.set(context.discussionId, { threadId });
        const abortHandler = () => { void this.interruptTurn(context.discussionId); };
        context.signal?.addEventListener('abort', abortHandler, { once: true });
        try {
          if (context.signal?.aborted) throw new ProviderError('CANCELLED', 'Codex App Server request was cancelled');
          const turnResponse = await this.request('turn/start', {
            threadId,
            input: [{
              type: 'text',
              text: buildPeerPrompt(context.prompt, resumed ? [] : context.previousMessages ?? []),
            }],
            ...(this.model ? { model: this.model } : {}),
          }, this.startupTimeoutMs);
          turnStarted = true;
          const turnId = readString(turnResponse.turnId) ?? readNestedString(turnResponse, ['turn', 'id']);
          if (!turnId) throw new ProviderError('PROTOCOL', 'Codex App Server did not return a turn id');
          this.activeTurns.set(context.discussionId, { threadId, turnId });
          let content: string;
          content = await this.collectTurn(threadId, turnId);
          return {
            content,
            duration: Date.now() - started,
            providerSessionId: threadId,
            providerSessionKind: 'codex-app-server',
            availability: 'BACKGROUND',
          };
        } finally {
          context.signal?.removeEventListener('abort', abortHandler);
          this.activeTurns.delete(context.discussionId);
        }
      } catch (error) {
        if (isProviderError(error) && error.code === 'CANCELLED') throw error;
        const enriched = withStderr(error, this.stderrTail, turnStarted);
        this.closeServer();
        throw enriched;
      } finally {
        this.inFlight = false;
        this.activeActivity = undefined;
        this.activePermissionRequest = undefined;
        this.activePolicy = undefined;
        this.activeDiscussionId = undefined;
        this.activeDispatchId = undefined;
      }
    });
  }

  async cancel(discussionId?: string): Promise<void> {
    if (!discussionId) {
      this.closeServer();
      return;
    }
    await this.interruptTurn(discussionId);
  }

  async archiveSession(sessionId: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    try {
      await this.request('thread/archive', { threadId: sessionId }, this.startupTimeoutMs);
      return true;
    } catch (cause) {
      if (isUnsupportedMethod(cause)) return false;
      throw cause;
    }
  }

  private async runSerial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    this.closeServer();
    const child = spawn(this.command, [...this.serverArgs, 'app-server'], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENTBRIDGE_PEER_INVOCATION: '1' },
    });
    this.child = child;
    this.stderrTail = '';
    this.activeActivity?.({ kind: 'process_started', at: Date.now(), processAlive: true, connectionAlive: false });
    this.processHeartbeat = setInterval(() => {
      if (this.child === child && child.exitCode === null) {
        this.activeActivity?.({ kind: 'process_heartbeat', at: Date.now(), processAlive: true, connectionAlive: this.initialized });
      }
    }, 1_000);
    this.processHeartbeat.unref?.();
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-this.stderrBufferBytes);
    });
    child.stdout.on('data', (chunk: Buffer | string) => this.consume(chunk.toString()));
    child.once('error', (error) => this.failPending(error instanceof Error ? error : new Error(String(error))));
    child.once('close', (code, signal) => {
      if (this.processHeartbeat) clearInterval(this.processHeartbeat);
      this.processHeartbeat = undefined;
      this.activeActivity?.({ kind: 'process_exited', at: Date.now(), processAlive: false, connectionAlive: false, detail: `${code ?? 'null'}:${signal ?? 'none'}` });
      if (this.child === child) {
        this.initialized = false;
        this.child = undefined;
      }
      const suffix = this.stderrTail ? `: ${redact(this.stderrTail)}` : '';
      this.failPending(new Error(`Codex App Server exited (${code ?? 'null'}, ${signal ?? 'no signal'})${suffix}`));
    });

    await this.request('initialize', {
      clientInfo: { name: 'agentbridge', title: 'AgentBridge', version: '0.1.0' },
      capabilities: {},
    }, this.startupTimeoutMs);
    this.notify('initialized', {});
    this.initialized = true;
    this.activeActivity?.({ kind: 'provider_event', at: Date.now(), processAlive: true, connectionAlive: true, sessionAlive: true, detail: 'initialized' });
  }

  private async startThread(projectPath: string): Promise<string> {
    const response = await this.request('thread/start', {
      cwd: projectPath,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'agentbridge',
      ...(this.model ? { model: this.model } : {}),
    }, this.startupTimeoutMs);
    const threadId = readString(response.threadId) ?? readNestedString(response, ['thread', 'id']);
    if (!threadId) throw new ProviderError('PROTOCOL', 'Codex App Server did not return a thread id');
    return threadId;
  }

  private async collectTurn(threadId: string, turnId: string | undefined): Promise<string> {
    const deltaChunks: string[] = [];
    let finalItemText: string | undefined;
    const deadline = Date.now() + this.hardTimeoutMs;
    while (Date.now() < deadline) {
      const event = await this.nextEvent(deadline - Date.now());
      const params = isRecord(event.params) ? event.params : {};
      const eventThreadId = readString(params.threadId);
      if (eventThreadId && eventThreadId !== threadId) continue;
      const eventTurnId = readString(params.turnId) ?? readNestedString(params, ['turn', 'id']);
      if (turnId && eventTurnId && eventTurnId !== turnId) continue;

      const delta = readString(params.delta);
      if (delta && isDeltaMethod(event.method)) deltaChunks.push(delta);
      const itemText = readNestedString(params, ['item', 'text']);
      if (itemText && isMessageItem(params.item)) finalItemText = itemText;
      if (isTurnFailure(event.method)) {
        const status = readTurnStatus(params);
        throw new ProviderError(
          status === 'interrupted' || status === 'cancelled' ? 'CANCELLED' : 'FAILED',
          readString(params.message) ?? 'Codex App Server turn failed',
        );
      }
      if (isTurnCompleted(event.method)) {
        const status = readTurnStatus(params);
        if (!status) {
          throw new ProviderError('PROTOCOL', 'Codex App Server completed without a turn status');
        }
        if (status === 'interrupted' || status === 'cancelled') {
          throw new ProviderError('CANCELLED', `Codex App Server turn completed with status ${status}`);
        }
        if (['failed', 'error'].includes(status)) {
          throw new ProviderError('FAILED', `Codex App Server turn completed with status ${status}`);
        }
        if (!['completed', 'succeeded', 'success'].includes(status)) {
          throw new ProviderError(
            'PROTOCOL',
            `Codex App Server turn completed with status ${status}`,
          );
        }
        const finalText = readNestedString(params, ['turn', 'text']) ?? readString(params.text) ?? finalItemText;
        const content = finalText ?? deltaChunks.join('');
        if (!content) throw new ProviderError('PROTOCOL', 'Codex App Server completed without an agent message');
        return content;
      }
    }
    throw new ProviderError('TIMEOUT', `Codex App Server turn timed out after ${this.hardTimeoutMs}ms`);
  }

  private request(method: string, params: JsonObject, timeoutMs: number): Promise<JsonObject> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(new ProviderError('UNAVAILABLE', 'Codex App Server is not running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError('TIMEOUT', `Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ProviderError('UNAVAILABLE', `Codex App Server request failed: ${method}`, { cause: error }));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { continue; }
      const method = typeof message.method === 'string' ? message.method : undefined;
      const params = isRecord(message.params) ? message.params : {};
      this.activeActivity?.({
        kind: 'provider_event',
        at: Date.now(),
        processAlive: true,
        connectionAlive: this.initialized,
        sessionAlive: true,
        detail: method,
      });
      if (method && isDeltaMethod(method)) {
        this.activeActivity?.({ kind: 'output', at: Date.now(), processAlive: true, connectionAlive: true, sessionAlive: true });
      }
      if (method && /turn[/.](start|started)/i.test(method)) {
        this.activeActivity?.({ kind: 'turn_started', at: Date.now(), processAlive: true, connectionAlive: true, sessionAlive: true });
      } else if (method && isTurnCompleted(method)) {
        this.activeActivity?.({ kind: 'turn_completed', at: Date.now(), processAlive: true, connectionAlive: true, sessionAlive: true });
      }
      const tool = readString(params.tool)
        ?? readString(params.toolName)
        ?? readNestedString(params, ['item', 'name'])
        ?? readNestedString(params, ['item', 'command']);
      if (method && isToolStartedMethod(method)) {
        this.activeActivity?.({ kind: 'tool_started', at: Date.now(), currentTool: tool ?? method, processAlive: true, connectionAlive: true, sessionAlive: true });
      } else if (method && isToolCompletedMethod(method)) {
        this.activeActivity?.({ kind: 'tool_completed', at: Date.now(), currentTool: tool, processAlive: true, connectionAlive: true, sessionAlive: true });
      }
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id !== undefined && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        if (isRecord(message.error)) pending.reject(providerErrorFromMessage(message.error));
        else pending.resolve(isRecord(message.result) ? message.result : {});
      } else if (typeof message.method === 'string' && message.id !== undefined) {
        void this.respondToServerRequest(message);
      } else if (typeof message.method === 'string') {
        const waiter = this.eventWaiters.shift();
        if (waiter) waiter(message);
        else this.events.push(message);
      }
    }
  }

  private async respondToServerRequest(message: JsonObject): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return;
    const method = String(message.method);
    const id = message.id;
    const policy = this.activePolicy?.decide({
      method,
      params: isRecord(message.params) ? message.params : undefined,
    }) ?? 'DENY';
    let decision: PermissionDecision | undefined;
    if (/approval|permission/i.test(method) && policy === 'NEEDS_USER_DECISION' && this.activePermissionRequest) {
      const params = isRecord(message.params) ? message.params : {};
      try {
        decision = await this.activePermissionRequest({
          discussionId: this.activeDiscussionId ?? '',
          dispatchId: this.activeDispatchId ?? '',
          provider: 'codex',
          method,
          actionType: readString(params.actionType) ?? readString(params.toolName) ?? 'provider_action',
          command: readString(params.command) ?? readString(params.cmd),
          paths: readStringArray(params.paths) ?? (readString(params.path) ? [readString(params.path)!] : undefined),
          reason: readString(params.reason) ?? readString(params.message),
          risk: 'unknown',
        });
      } catch {
        decision = 'deny';
      }
    }
    const response = /approval|permission/i.test(method)
      ? { id, result: { decision: decision === 'approve' || policy === 'ALLOW' ? 'allow' : 'decline', reason: decision ?? policy } }
      : { id, error: { code: -32601, message: `AgentBridge cannot satisfy interactive request ${method}` } };
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    }
  }

  private nextEvent(timeoutMs: number): Promise<JsonObject> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (event: JsonObject) => { clearTimeout(timer); resolve(event); };
      const timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new ProviderError('TIMEOUT', 'Codex App Server emitted no turn event before timeout'));
      }, Math.max(1, timeoutMs));
      this.eventWaiters.push(waiter);
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    while (this.eventWaiters.length > 0) this.eventWaiters.shift()!( { method: 'turn/failed', params: { message: error.message } } );
  }

  private async interruptTurn(discussionId: string): Promise<void> {
    const active = this.activeTurns.get(discussionId);
    if (!active || !this.child || this.child.exitCode !== null || this.child.killed) return;
    try {
      await this.request('turn/interrupt', {
        threadId: active.threadId,
        ...(active.turnId ? { turnId: active.turnId } : {}),
      }, Math.min(5_000, this.startupTimeoutMs));
    } catch {
      this.closeServer();
    }
  }

  private closeServer(): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.availability = undefined;
    if (this.processHeartbeat) clearInterval(this.processHeartbeat);
    this.processHeartbeat = undefined;
    this.buffer = '';
    this.events.splice(0, this.events.length);
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* continue with the SIGKILL fallback */ }
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch { /* child close will report the failure */ }
        }
      }, 2_000);
      forceKillTimer.unref();
      child.once('close', () => clearTimeout(forceKillTimer));
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readTurnStatus(params: JsonObject): string | undefined {
  const value = readString(params.status)
    ?? readNestedString(params, ['turn', 'status'])
    ?? readNestedString(params, ['turn', 'state']);
  return value?.toLowerCase();
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return readString(current);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeltaMethod(method: unknown): boolean {
  return typeof method === 'string' && /agent.?message.*delta/i.test(method);
}

function isToolStartedMethod(method: unknown): boolean {
  return typeof method === 'string' && /(tool|item|command|exec).*(start|begin|started)/i.test(method);
}

function isToolCompletedMethod(method: unknown): boolean {
  return typeof method === 'string' && /(tool|item|command|exec).*(complete|finish|end|completed|finished)/i.test(method);
}

function isMessageItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = readString(value.type);
  return type === 'agentMessage' || type === 'agent_message';
}

function isTurnCompleted(method: unknown): boolean {
  return method === 'turn/completed' || method === 'turn.completed';
}

function isTurnFailure(method: unknown): boolean {
  return method === 'turn/failed' || method === 'turn.failed' || method === 'error';
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return result.length > 0 ? result : undefined;
}

function providerErrorFromMessage(message: JsonObject): ProviderError {
  const text = readString(message.message) ?? `Codex App Server error: ${String(message.code ?? 'unknown')}`;
  const lower = text.toLowerCase();
  const code = isSessionLostError({ message: text })
    ? 'SESSION_LOST'
    : /auth|unauthori[sz]ed|forbidden|credential|login/.test(lower)
      ? 'AUTH'
      : /rate.?limit|too many requests|quota/.test(lower)
        ? 'RATE_LIMIT'
        : /busy|overload|capacity/.test(lower)
          ? 'BUSY'
          : /timeout|timed out/.test(lower)
            ? 'TIMEOUT'
            : 'PROTOCOL';
  return new ProviderError(code, text);
}

function isSessionLostError(error: unknown): boolean {
  if (isProviderError(error) && error.code === 'SESSION_LOST') return true;
  const text = error instanceof Error ? error.message : String(error);
  return /session|thread/i.test(text) && /not found|missing|lost|expired|invalid|unknown/i.test(text);
}

function isUnsupportedMethod(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /method.*not found|unsupported|unknown method/i.test(text);
}

function redact(value: string): string {
  return value
    .replace(/(token|password|api[_ -]?key)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]')
    .trim();
}

function withStderr(error: unknown, stderrTail: string, ambiguous = false): Error {
  const stderr = redact(stderrTail);
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (!stderr && !ambiguous) return error instanceof Error ? error : new Error(baseMessage);
  const message = stderr ? `${baseMessage}; stderr: ${stderr}` : baseMessage;
  if (isProviderError(error)) {
    return new ProviderError(error.code, message, {
      retryable: error.retryable,
      ambiguous: error.ambiguous || ambiguous,
      backend: error.backend,
      cause: error,
    });
  }
  if (ambiguous) return new ProviderError('FAILED', message, { ambiguous: true, cause: error });
  return new Error(message, { cause: error });
}
