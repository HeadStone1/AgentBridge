import type {
  AgentSession,
  AgentType,
  AuditEvent,
  Decision,
  Discussion,
  DiscussionStatus,
  Message,
  MessageRole,
  SessionStatus,
} from '@agentbridge/protocol';

/**
 * Storage boundary used by the domain services.
 *
 * Keeping this contract separate from the SQLite implementation makes a
 * future node:sqlite or cloud-backed adapter a contained change.
 */
export interface StoragePort {
  createDiscussion(data: {
    topic: string;
    driver: AgentType;
    projectPath?: string;
    peer?: AgentType;
    traceId: string;
    maxTurns?: number;
    maxRetries?: number;
  }): Discussion;
  getDiscussion(id: string): Discussion | null;
  updateDiscussionStatus(id: string, status: DiscussionStatus, extra?: Partial<Discussion>): void;
  incrementDiscussionRound(id: string): Discussion;
  incrementRetry(id: string): Discussion;
  createMessage(data: {
    discussionId: string;
    sender: AgentType;
    receiver: AgentType;
    role: MessageRole;
    content: string;
    parentMessageId?: string | null;
    correlationId?: string;
    gitCommit?: string;
    gitBranch?: string;
    projectPath?: string;
    providerSessionId?: string;
  }): Message;
  getMessages(discussionId: string, afterId?: string): Message[];
  createDecision(data: {
    discussionId: string;
    summary: string;
    changes: string[];
    agreedBy: AgentType[];
  }): Decision;
  getDecisionByDiscussion(discussionId: string): Decision | null;
  recordAgreement(data: {
    discussionId: string;
    agent: AgentType;
    summary: string;
    changes?: string[];
  }): { decisionHash: string; agreedBy: AgentType[] };
  acquireSessionLease(data: {
    provider: AgentType;
    projectPath: string;
    ownerId: string;
    ttlMs?: number;
  }): void;
  releaseSessionLease(provider: AgentType, projectPath: string, ownerId: string): void;
  renewSessionLease(provider: AgentType, projectPath: string, ownerId: string, ttlMs?: number): boolean;
  hasSessionLease(provider: AgentType, projectPath: string, ownerId?: string): boolean;
  acquireDiscussionLease(data: {
    discussionId: string;
    projectPath: string;
    ownerId: string;
    ttlMs?: number;
  }): void;
  releaseDiscussionLease(discussionId: string, ownerId: string): void;
  renewDiscussionLease(discussionId: string, ownerId: string, ttlMs?: number): boolean;
  hasDiscussionLease(discussionId: string, ownerId?: string): boolean;
  recoverExpiredSessionLeases(now?: Date): number;
  recoverStaleDiscussions(maxAgeMs?: number): Discussion[];
  pruneSessions(maxAgeMs?: number): number;
  appendAudit(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent;
  getAuditLog(discussionId?: string, limit?: number): AuditEvent[];

  registerSession(data: {
    provider: AgentType;
    sessionId: string;
    projectPath: string;
    status?: SessionStatus;
    metadata?: Record<string, unknown>;
  }): AgentSession;
  updateSessionStatus(
    provider: AgentType,
    sessionId: string,
    status: SessionStatus,
    metadata?: Record<string, unknown>,
  ): AgentSession;
  getSessionForDiscussion(
    provider: AgentType,
    discussionId: string,
    projectPath: string,
  ): AgentSession | null;
}
