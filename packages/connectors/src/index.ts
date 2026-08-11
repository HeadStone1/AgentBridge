import type { Message } from '@agentbridge/protocol';
import type { AgentType, PeerAvailability } from '@agentbridge/protocol';

export type ProviderSessionKind = 'claude-cli' | 'codex-cli' | 'codex-app-server';

export interface PeerResponse {
  content: string;
  duration: number; // ms
  providerSessionId?: string;
  providerSessionKind?: ProviderSessionKind;
  availability?: PeerAvailability;
  backendSwitched?: { from: 'app-server'; to: 'cli'; reason: string };
}

export interface AgentConnector {
  /**
   * The agent type this connector handles
   */
  readonly agentType: AgentType;

  /**
   * Whether the agent is currently reachable/online
   */
  isAvailable(): Promise<boolean>;

  /** Return the best available operating mode for this provider. */
  getAvailability?(): Promise<PeerAvailability>;

  /**
   * Send a message to the peer and wait for their response.
   * This is the core Driver pattern: the calling agent drives the whole
   * discussion loop by calling this method iteratively.
   *
   * @param context - Project context to provide to the peer
   * @param prompt - The specific question or proposal to discuss
   * @param discussionId - For correlation in logs
   */
  sendAndWait(context: {
    projectPath: string;
    prompt: string;
    discussionId: string;
    previousMessages?: Message[];
    providerSessionId?: string;
    providerSessionKind?: ProviderSessionKind;
    signal?: AbortSignal;
  }): Promise<PeerResponse>;

  /**
   * Check if the agent is currently busy (running a task)
   */
  isBusy(): Promise<boolean>;

  /** Best-effort cancellation for adapters that support it. */
  cancel?(discussionId: string): Promise<void>;
}

export { ClaudeConnector } from './claude.js';
export { CodexConnector } from './codex.js';
export { CodexAppServerConnector } from './codexAppServer.js';
export { CodexAutoConnector } from './codexAuto.js';
export { discoverCodexCommands } from './codexDiscovery.js';
export { buildPeerPrompt } from './prompt.js';
export type { CodexBackendSelection, CodexAutoConnectorOptions } from './codexAuto.js';
export type { CodexBackendMode, CodexCommandCandidate, CodexDiscoveryOptions } from './codexDiscovery.js';
