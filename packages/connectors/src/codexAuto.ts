import type { Message } from '@agentbridge/protocol';
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
  model?: string;
  sandbox?: CodexConnectorOptions['sandbox'];
  appServerArgs?: string[];
  cliExtraArgs?: string[];
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
  }): Promise<PeerResponse> {
    const selected = await this.selectBackend();
    if (!selected) {
      const attempted = this.candidates.map((candidate) => candidate.command).join(', ') || '(none)';
      throw new Error(
        `No usable Codex backend was found (mode: ${this.mode}; attempted: ${attempted}). `
        + 'Install Codex Desktop/CLI or set AGENTBRIDGE_CODEX_APP_COMMAND.',
      );
    }
    return selected.connector.sendAndWait(context);
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

  private selectBackend(): Promise<SelectedBackend | undefined> {
    this.selection ??= this.findBackend();
    return this.selection;
  }

  private async findBackend(): Promise<SelectedBackend | undefined> {
    if (this.mode !== 'cli') {
      for (const candidate of this.candidates) {
        if (candidate.mode === 'cli') continue;
        const connector = new CodexAppServerConnector({
          command: candidate.command,
          serverArgs: [...(candidate.args ?? []), ...(this.options.appServerArgs ?? [])],
          timeoutMs: this.options.timeoutMs,
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
