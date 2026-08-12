import type {
  AgentSession,
  AgentType,
  AuditEvent,
  Decision,
  Discussion,
  DiscussionStatus,
  DispatchState,
  DiscussionError,
  DiscussionStopReason,
  Message,
  MessageRole,
  SessionStatus,
  SessionPolicy,
  CollaborationSession,
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
    collaborationSessionId?: string;
  }): Discussion;
  createCollaborationSession(data: {
    projectPath: string;
    policy?: SessionPolicy;
  }): CollaborationSession;
  getOrCreateCollaborationSession(data: {
    projectPath: string;
    policy?: Exclude<SessionPolicy, 'fresh'>;
  }): CollaborationSession;
  getCollaborationSession(id: string): CollaborationSession | null;
  getSessionForCollaboration(
    provider: AgentType,
    collaborationSessionId: string,
    projectPath: string,
  ): AgentSession | null;
  bindProviderSession(data: {
    collaborationSessionId: string;
    provider: AgentType;
    sessionId: string;
  }): void;
  getDiscussion(id: string): Discussion | null;
  updateDiscussionStatus(id: string, status: DiscussionStatus, extra?: Partial<Discussion>): void;
  updateDiscussionDispatch(id: string, state: DispatchState | null, waitingFor?: AgentType | null): void;
  updateDiscussionDiagnostic(id: string, stopReason: DiscussionStopReason | null, lastError?: DiscussionError | null): void;
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
  cleanupDiscussions(olderThanDays: number, execute?: boolean): { cutoff: string; count: number; discussionIds: string[]; deleted: boolean };
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
  listSessionsForDiscussion(discussionId: string): AgentSession[];
}
