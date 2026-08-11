import type { Message } from '@agentbridge/protocol';
import { isProviderError } from '@agentbridge/protocol';
import type { AgentConnector, PeerResponse, ProviderSessionKind } from './index.js';
import { CodexAppServerConnector } from './codexAppServer.js';
import { CodexConnector, type CodexConnectorOptions } from './codex.js';
import {
  discoverCodexCommands,
  type CodexBackendMode,
  type CodexCommandCandidate,
} from './codexDiscovery.js';

export interface CodexAutoConnectorOptions {
  mode?: CodexBackendMode;
  candidates?: CodexCommandCandidate[];
  timeoutMs?: number;
  startupTimeoutMs?: number;
  model?: string;
  sandbox?: CodexConnectorOptions['sandbox'];
  appServerArgs?: string[];
  cliExtraArgs?: string[];
  selectionTtlMs?: number;
  failedSelectionTtlMs?: number;
}

export interface CodexBackendSelection {
  mode: Exclude<CodexBackendMode, 'auto'>;
  command: string;
  source: CodexCommandCandidate['source'];
  label: string;
}

interface SelectedBackend {
  info: CodexBackendSelection;
  connector: AgentConnector;
}

/** GUI-first adapter: prefer App Server, then fall back to `codex exec`. */
export class CodexAutoConnector implements AgentConnector {
  readonly agentType = 'codex' as const;
  private readonly mode: CodexBackendMode;
  private readonly candidates: CodexCommandCandidate[];
  private readonly options: CodexAutoConnectorOptions;
  private selection?: Promise<SelectedBackend | undefined>;
  private selectionExpiresAt = 0;

  constructor(options: CodexAutoConnectorOptions = {}) {
    this.mode = options.mode ?? readMode(process.env.AGENTBRIDGE_CODEX_MODE);
    this.candidates = options.candidates ?? discoverCodexCommands();
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.selectBackend()) !== undefined;
  }

  async getAvailability(): Promise<'BACKGROUND' | 'UNAVAILABLE'> {
    return (await this.isAvailable()) ? 'BACKGROUND' : 'UNAVAILABLE';
  }

  async isBusy(): Promise<boolean> {
    const selected = await this.selectBackend();
    return selected ? selected.connector.isBusy() : false;
  }

  async sendAndWait(context: {
    projectPath: string;
    prompt: string;
    discussionId: string;
    previousMessages?: Message[];
    providerSessionId?: string;
    providerSessionKind?: ProviderSessionKind;
    signal?: AbortSignal;
  }): Promise<PeerResponse> {
    const selected = await this.selectBackend();
    if (!selected) {
      const attempted = this.candidates.map((candidate) => candidate.command).join(', ') || '(none)';
      throw new Error(
        `No usable Codex backend was found (mode: ${this.mode}; attempted: ${attempted}). `
        + 'Install Codex Desktop/CLI or set AGENTBRIDGE_CODEX_APP_COMMAND.',
      );
    }
    try {
      return await selected.connector.sendAndWait(context);
    } catch (cause) {
      if (selected.info.mode !== 'app-server' || this.mode !== 'auto' || !shouldFallback(cause)) throw cause;
      this.invalidateSelection();
      const fallback = await this.selectBackend(true, 'cli');
      if (!fallback) throw cause;
      const response = await fallback.connector.sendAndWait(context);
      return {
        ...response,
        backendSwitched: {
          from: 'app-server',
          to: 'cli',
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  }

  async cancel(discussionId: string): Promise<void> {
    const selected = await this.selectBackend();
    await selected?.connector.cancel?.(discussionId);
  }

  async getSelection(): Promise<CodexBackendSelection | undefined> {
    return (await this.selectBackend())?.info;
  }

  getCandidates(): readonly CodexCommandCandidate[] {
    return this.candidates;
  }

  private selectBackend(force = false, only?: 'cli'): Promise<SelectedBackend | undefined> {
    if (force || !this.selection || Date.now() >= this.selectionExpiresAt) {
      const selection = this.findBackend(only);
      this.selection = selection.then((selected) => {
        this.selectionExpiresAt = Date.now() + (selected
          ? this.options.selectionTtlMs ?? 10 * 60 * 1_000
          : this.options.failedSelectionTtlMs ?? 5_000);
        return selected;
      });
    }
    return this.selection;
  }

  private invalidateSelection(): void {
    this.selection = undefined;
    this.selectionExpiresAt = 0;
  }

  private async findBackend(only?: 'cli'): Promise<SelectedBackend | undefined> {
    if (this.mode !== 'cli' && only !== 'cli') {
      for (const candidate of this.candidates) {
        if (candidate.mode === 'cli') continue;
        const connector = new CodexAppServerConnector({
          command: candidate.command,
          serverArgs: [...(candidate.args ?? []), ...(this.options.appServerArgs ?? [])],
          timeoutMs: this.options.timeoutMs,
          startupTimeoutMs: this.options.startupTimeoutMs,
          model: this.options.model,
        });
        if (await connector.isAvailable()) {
          return { connector, info: backendInfo(candidate, 'app-server') };
        }
      }
    }

    if (this.mode !== 'app-server') {
      for (const candidate of this.candidates) {
        if (candidate.mode === 'app-server') continue;
        const connector = new CodexConnector({
          command: candidate.command,
          timeoutMs: this.options.timeoutMs,
          model: this.options.model,
          sandbox: this.options.sandbox,
          extraArgs: [...(candidate.args ?? []), ...(this.options.cliExtraArgs ?? [])],
        });
        if (await connector.isAvailable()) {
          return { connector, info: backendInfo(candidate, 'cli') };
        }
      }
    }

    return undefined;
  }
}

function backendInfo(
  candidate: CodexCommandCandidate,
  mode: CodexBackendSelection['mode'],
): CodexBackendSelection {
  return { mode, command: candidate.command, source: candidate.source, label: candidate.label };
}

function readMode(value: string | undefined): CodexBackendMode {
  if (!value?.trim()) return 'auto';
  if (value === 'auto' || value === 'app-server' || value === 'cli') return value;
  throw new Error('AGENTBRIDGE_CODEX_MODE must be auto, app-server, or cli');
}

function shouldFallback(error: unknown): boolean {
  return !(isProviderError(error) && (
    error.ambiguous || ['AUTH', 'RATE_LIMIT', 'CANCELLED'].includes(error.code)
  ));
}
