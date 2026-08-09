// Core types for AgentBridge protocol

export type AgentType = 'claude' | 'codex';
export type SessionStatus = 'IDLE' | 'BUSY' | 'BRIDGE_OWNED' | 'UNKNOWN';
export type PeerAvailability = 'INTERACTIVE' | 'BACKGROUND' | 'UNAVAILABLE';
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
  maxTurns: number;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  conclusion: string | null;
  projectPath: string;
  traceId: string;
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
}

export interface AskPeerOutput {
  discussionId: string;
  peer: AgentType;
  messageId: string;
  status: DiscussionStatus;
  peerResponse?: Message;
}

export interface ReplyPeerInput {
  discussionId: string;
  message: string;
}

export interface ReplyPeerOutput {
  messageId: string;
  status: DiscussionStatus;
  peerResponse?: Message;
}

export interface GetDiscussionInput {
  discussionId: string;
}

export interface GetDiscussionOutput {
  discussion: Discussion;
  messages: Message[];
  decision: Decision | null;
}

export interface CloseDiscussionInput {
  discussionId: string;
  conclusion: string;
}

export interface CloseDiscussionOutput {
  discussionId: string;
  status: DiscussionStatus;
  decisionId?: string;
  waitingFor?: AgentType[];
}

export interface CancelDiscussionOutput {
  discussionId: string;
  status: 'CANCELLED';
}

export interface RetryDiscussionOutput {
  discussionId: string;
  status: 'DISCUSSING';
  retryCount: number;
}

export * from './stateMachine.js';
