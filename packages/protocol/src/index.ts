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
export type SessionStatus = 'IDLE' | 'BUSY' | 'BRIDGE_OWNED' | 'ARCHIVED' | 'UNKNOWN';
export type PeerAvailability = 'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE';
export type DispatchState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type DiscussionStopReason = 'MAX_TURNS' | 'MAX_DURATION' | 'MESSAGE_BUDGET' | 'PROVIDER_ERROR';

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
  traceId: string;
  /** Persisted provider-dispatch lifecycle, independent from discussion status. */
  dispatchState: DispatchState | null;
  /** Agent expected to receive or act on the current dispatch, when applicable. */
  waitingFor: AgentType | null;
  stopReason: DiscussionStopReason | null;
  lastError: DiscussionError | null;
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
  /** Maximum successful provider responses for this discussion. */
  maxTurns?: number;
}

export interface AskPeerOutput {
  discussionId: string;
  peer: AgentType;
  messageId: string;
  status: DiscussionStatus;
  dispatchState?: DispatchState;
  peerResponse?: Message;
}

export interface ReplyPeerInput {
  discussionId: string;
  message: string;
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
  status: 'DISCUSSING';
  retryCount: number;
  dispatchState?: DispatchState;
  peerResponse?: Message;
}

export * from './stateMachine.js';
export * from './errors.js';
