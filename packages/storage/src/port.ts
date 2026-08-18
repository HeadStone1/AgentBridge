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
  DiscussionOperationKind,
  DiscussionOrchestration,
  DiscussionMode,
  TaskType,
  ValidationMode,
  SharedBlackboard,
  SharedBlackboardEntry,
  DiscussionSignal,
  Message,
  MessageRole,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestStatus,
  PeerPermissionRequestInput,
  PeerRuntimeEvent,
  PeerRuntimeState,
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
    mode?: DiscussionMode;
    taskType?: TaskType;
    validationMode?: ValidationMode;
    peerTemperature?: number | null;
    maxTurns?: number;
    maxRetries?: number;
    collaborationSessionId?: string;
    orchestration?: DiscussionOrchestration;
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
  getPeerRuntime(discussionId: string): PeerRuntimeState | null;
  upsertPeerRuntime(state: PeerRuntimeState): void;
  appendPeerRuntimeEvent(event: Omit<PeerRuntimeEvent, 'id' | 'sequence' | 'timestamp'> & { timestamp?: string }): PeerRuntimeEvent;
  getPeerRuntimeEvents(discussionId: string, afterSequence?: number, limit?: number): PeerRuntimeEvent[];
  createPermissionRequest(request: PeerPermissionRequestInput): PermissionRequest;
  getPermissionRequest(id: string): PermissionRequest | null;
  listPermissionRequests(discussionId: string, statuses?: PermissionRequestStatus[]): PermissionRequest[];
  resolvePermissionRequest(id: string, decision: PermissionDecision, resolvedBy?: PermissionRequest['resolvedBy']): PermissionRequest;
  expirePermissionRequest(id: string): PermissionRequest;
  recoverOrphanedDiscussions(isOwnerAlive: (ownerId: string) => boolean): Discussion[];
  updateDiscussionStatus(id: string, status: DiscussionStatus, extra?: Partial<Discussion>): void;
  updateDiscussionMode(id: string, mode: DiscussionMode): void;
  updateDiscussionPolicy(id: string, mode: DiscussionMode, orchestration: DiscussionOrchestration): void;
  appendBlackboardEntry(id: string, entry: Omit<SharedBlackboardEntry, 'timestamp' | 'versionAdded'> & { timestamp?: string }): SharedBlackboard;
  updateDiscussionDispatch(id: string, state: DispatchState | null, waitingFor?: AgentType | null): void;
  updateDiscussionFailure(id: string, failure: {
    receiver: AgentType | null;
    messageId: string | null;
    operationKind: DiscussionOperationKind | null;
  }): void;
  updateDiscussionPending(id: string, operationKind: DiscussionOperationKind | null, messageId: string | null): void;
  updateDiscussionSignal(id: string, signal: DiscussionSignal | null): void;
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
  clearAgreements(discussionId: string): void;
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
