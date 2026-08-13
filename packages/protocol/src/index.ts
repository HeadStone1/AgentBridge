// Core types for AgentBridge protocol
import { resolve } from 'node:path';

/** Resolve the stable project root shared by MCP hosts and direct CLI use. */
export function resolveProjectPath(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const candidate = [explicit, env.AGENTBRIDGE_PROJECT_PATH, env.CLAUDE_PROJECT_DIR, cwd]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  return resolve(candidate ?? cwd);
}

export type AgentType = 'claude' | 'codex';
export type SessionPolicy = 'auto' | 'reuse' | 'fresh';
export const DISCUSSION_MODES = ['review', 'discussion', 'deep-discussion'] as const;
export type DiscussionMode = (typeof DISCUSSION_MODES)[number];
export type DiscussionSignal = 'CONTINUE' | 'READY_TO_CLOSE' | 'NEEDS_USER_DECISION';
export const DEFAULT_DISCUSSION_MODE: DiscussionMode = 'discussion';
export const DEFAULT_MAX_TURNS_BY_MODE: Readonly<Record<DiscussionMode, number>> = {
  review: 3,
  discussion: 12,
  'deep-discussion': 20,
};
export type SessionStatus = 'IDLE' | 'BUSY' | 'BRIDGE_OWNED' | 'ARCHIVED' | 'UNKNOWN';
export type PeerAvailability = 'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE';
export type DispatchState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type DiscussionStopReason =
  | 'MAX_TURNS'
  | 'MAX_DURATION'
  | 'MESSAGE_BUDGET'
  | 'PROVIDER_ERROR'
  | 'PEER_REQUESTED_USER_DECISION';
export type DiscussionOperationKind = 'peer_message' | 'agreement_confirmation';

export interface DiscussionError {
  code: string;
  message: string;
  backend: string | null;
  retryable: boolean;
  ambiguous: boolean;
  at: string;
}
export type DiscussionStatus =
  | 'CREATED'
  | 'DISCUSSING'
  | 'AGREED'
  | 'IMPLEMENTING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PEER_BUSY'
  | 'TIMEOUT'
  | 'NEEDS_USER_DECISION';

export type MessageRole = 'proposal' | 'response' | 'conclusion' | 'system';

export interface Message {
  id: string;
  discussionId: string;
  sender: AgentType;
  receiver: AgentType;
  role: MessageRole;
  content: string;
  createdAt: string; // ISO 8601 UTC
  parentMessageId: string | null;
  correlationId: string;
  // Context snapshot at send time
  gitCommit?: string;
  gitBranch?: string;
  projectPath?: string;
  providerSessionId?: string;
}

export interface Discussion {
  id: string;
  topic: string;
  /** Persisted behavior contract controlling evidence, challenge, and convergence depth. */
  mode: DiscussionMode;
  status: DiscussionStatus;
  driver: AgentType; // Who initiated this discussion
  peer: AgentType;
  currentTurn: number;
  roundCount: number;
  maxTurns: number;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  conclusion: string | null;
  projectPath: string;
  /** Project-scoped collaboration session used to reuse provider-native sessions. */
  collaborationSessionId: string | null;
  traceId: string;
  /** Persisted provider-dispatch lifecycle, independent from discussion status. */
  dispatchState: DispatchState | null;
  /** Agent expected to receive or act on the current dispatch, when applicable. */
  waitingFor: AgentType | null;
  /** Latest machine-readable convergence signal returned by a peer. */
  lastSignal: DiscussionSignal | null;
  stopReason: DiscussionStopReason | null;
  lastError: DiscussionError | null;
  /** Exact dispatch that failed and may be eligible for explicit retry. */
  failedDispatchReceiver: AgentType | null;
  failedMessageId: string | null;
  failedOperationKind: DiscussionOperationKind | null;
}

export interface AgentSession {
  provider: AgentType;
  sessionId: string;
  projectPath: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
}

export interface Decision {
  id: string;
  discussionId: string;
  summary: string;
  changes: string[];
  decisionHash: string; // Canonical representation hash
  createdAt: string;
  agreedBy: AgentType[];
}

export interface AuditEvent {
  id: string;
  traceId: string;
  discussionId: string | null;
  action: string; // e.g. 'discussion.created', 'message.sent', 'peer.response'
  agent: AgentType | 'system';
  timestamp: string;
  metadata: Record<string, unknown>;
}

// MCP Tool input/output types

export interface AskPeerInput {
  peer: AgentType;
  message: string;
  projectPath?: string;
  /** Discussion behavior contract; defaults to discussion. */
  mode?: DiscussionMode;
  /** Maximum successful provider responses for this discussion. */
  maxTurns?: number;
  /** Provider-session reuse policy; defaults to the service's auto policy. */
  sessionPolicy?: SessionPolicy;
}

export interface CollaborationSession {
  id: string;
  projectPath: string;
  status: 'ACTIVE' | 'ARCHIVED';
  policy: SessionPolicy;
  claudeSessionId: string | null;
  codexSessionId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface AskPeerOutput {
  discussionId: string;
  collaborationSessionId?: string | null;
  peer: AgentType;
  mode: DiscussionMode;
  maxTurns: number;
  messageId: string;
  status: DiscussionStatus;
  dispatchState?: DispatchState;
  peerResponse?: Message;
}

export interface ReplyPeerInput {
  discussionId: string;
  message: string;
  /** Optional monotonic upgrade of the discussion depth contract. */
  mode?: DiscussionMode;
}

export interface ReplyPeerOutput {
  messageId: string;
  status: DiscussionStatus;
  dispatchState?: DispatchState;
  peerResponse?: Message;
}

export interface GetDiscussionInput {
  discussionId: string;
}

export interface GetDiscussionOutput {
  discussion: Discussion;
  messages: Message[];
  decision: Decision | null;
  providerSessions: ProviderSessionSummary[];
}

export interface ProviderSessionSummary {
  provider: AgentType;
  sessionId: string;
  kind: string | null;
  status: SessionStatus;
  lastSeenAt: string;
}

export interface WaitDiscussionInput {
  discussionId: string;
  timeoutMs?: number;
  afterMessageId?: string;
}

export interface WaitDiscussionOutput extends GetDiscussionOutput {
  waitTimedOut: boolean;
  lastMessageId: string | null;
}

export interface CloseDiscussionInput {
  discussionId: string;
  conclusion: string;
}

export interface CloseDiscussionOutput {
  discussionId: string;
  status: DiscussionStatus;
  dispatchState?: DispatchState;
  decisionId?: string;
  waitingFor?: AgentType[];
  peerAccepted?: boolean;
  peerResponse?: Message;
}

export interface CancelDiscussionOutput {
  discussionId: string;
  status: 'CANCELLED';
}

export interface RetryDiscussionOutput {
  discussionId: string;
  status: 'DISCUSSING' | 'NEEDS_USER_DECISION';
  retryCount: number;
  dispatchState?: DispatchState;
  peerResponse?: Message;
}

export * from './stateMachine.js';
export * from './errors.js';
