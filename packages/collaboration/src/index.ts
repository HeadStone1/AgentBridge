import { randomUUID } from 'node:crypto';
import type { StoragePort } from '@agentbridge/storage';
import { AuditService } from '@agentbridge/audit';
import type { AgentConnector, PeerResponse, ProviderSessionKind } from '@agentbridge/connectors';
import type {
  AgentType,
  AgreementResolution,
  Discussion,
  DiscussionMode,
  SessionPolicy,
  Message,
  AskPeerOutput,
  ReplyPeerOutput,
  GetDiscussionOutput,
  CloseDiscussionOutput,
  CancelDiscussionOutput,
  RetryDiscussionOutput,
  WaitDiscussionOutput,
  DiscussionOperationKind,
  PermissionDecision,
  PermissionRequest,
  PeerPermissionRequestInput,
  PeerActivity,
  PeerRuntimeEvent,
  PeerRuntimeState,
  PeerRuntimePhase,
  WatchDiscussionOutput,
  DiscussionNextAction,
} from '@agentbridge/protocol';
import {
  canRetry,
  isPaused,
  isProviderError,
  isTerminal,
  ProviderError,
  SessionBusyError,
  resolveProjectPath,
} from '@agentbridge/protocol';
import {
  buildDiscussionPrompt,
  buildAutomaticTurnPrompt,
  defaultMaxTurnsForMode,
  discussionPhase,
  isAutomaticDiscussionMode,
  parseDiscussionSignal,
  resolveDiscussionMode,
} from './discussionPolicy.js';

export {
  assertDiscussionMode,
  buildDiscussionPrompt,
  buildAutomaticTurnPrompt,
  defaultMaxTurnsForMode,
  discussionPhase,
  isAutomaticDiscussionMode,
  parseDiscussionSignal,
  resolveDiscussionMode,
} from './discussionPolicy.js';

export interface CollaborationConfig {
  maxTurns?: number;
  /** Legacy alias for idleTimeoutMs and the session-lease TTL. */
  timeoutMs?: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  stallGraceMs?: number;
  turnHardLimitMs?: number;
  permissionTimeoutMs?: number;
  terminationGraceMs?: number;
  maxDurationMs?: number;
  maxTotalMessageChars?: number;
  asyncDispatch?: boolean;
  archiveSessionsOnClose?: boolean;
  sessionPolicy?: SessionPolicy;
}

export type ConnectorRegistry = Partial<Record<AgentType, AgentConnector>>;

interface InFlightOperation {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

export class CollaborationService {
  private readonly storage: StoragePort;
  private readonly audit: AuditService;
  private readonly maxTurns: number;
  private readonly maxTurnsWasConfigured: boolean;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly stallGraceMs: number;
  private readonly turnHardLimitMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly maxDurationMs: number;
  private readonly maxTotalMessageChars: number;
  private readonly asyncDispatch: boolean;
  private readonly archiveSessionsOnClose: boolean;
  private readonly sessionPolicy: SessionPolicy;
  private readonly connectors: ConnectorRegistry;
  private readonly ownerId = `collaboration:${process.pid}:${randomUUID()}`;
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly automaticRuns = new Set<string>();
  private readonly cancellationRequests = new Set<string>();
  private shuttingDown = false;

  constructor(
    storage: StoragePort,
    audit: AuditService,
    config: CollaborationConfig = {},
    connectors: ConnectorRegistry = {},
  ) {
    this.storage = storage;
    this.audit = audit;
    this.maxTurnsWasConfigured = config.maxTurns !== undefined;
    this.maxTurns = config.maxTurns ?? 12;
    this.idleTimeoutMs = config.idleTimeoutMs ?? config.timeoutMs ?? 120_000;
    // Keep lease renewal independent from the provider's output-idle budget.
    // A short idle threshold must not make a healthy session lease expire.
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.startupTimeoutMs = config.startupTimeoutMs ?? 30_000;
    this.stallGraceMs = config.stallGraceMs ?? 180_000;
    this.turnHardLimitMs = config.turnHardLimitMs ?? config.timeoutMs ?? 30 * 60 * 1_000;
    this.permissionTimeoutMs = config.permissionTimeoutMs ?? 120_000;
    this.terminationGraceMs = config.terminationGraceMs ?? 5_000;
    this.maxDurationMs = config.maxDurationMs ?? 30 * 60 * 1_000;
    this.maxTotalMessageChars = config.maxTotalMessageChars ?? 500_000;
    this.asyncDispatch = config.asyncDispatch ?? false;
    this.archiveSessionsOnClose = config.archiveSessionsOnClose ?? false;
    this.sessionPolicy = config.sessionPolicy ?? 'auto';
    if (!['auto', 'reuse', 'fresh'].includes(this.sessionPolicy)) throw new Error('sessionPolicy must be auto, reuse, or fresh');
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1 || this.maxTurns > 50) {
      throw new Error('maxTurns must be an integer between 1 and 50');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 600_000) {
      throw new Error('timeoutMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1_000 || this.idleTimeoutMs > 600_000) {
      throw new Error('idleTimeoutMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.startupTimeoutMs) || this.startupTimeoutMs < 1_000 || this.startupTimeoutMs > 600_000) {
      throw new Error('startupTimeoutMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.stallGraceMs) || this.stallGraceMs < 1_000 || this.stallGraceMs > 600_000) {
      throw new Error('stallGraceMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.turnHardLimitMs) || this.turnHardLimitMs < 1_000 || this.turnHardLimitMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('turnHardLimitMs must be an integer between 1000 and 604800000');
    }
    if (!Number.isInteger(this.permissionTimeoutMs) || this.permissionTimeoutMs < 1_000 || this.permissionTimeoutMs > 600_000) {
      throw new Error('permissionTimeoutMs must be an integer between 1000 and 600000');
    }
    if (!Number.isInteger(this.terminationGraceMs) || this.terminationGraceMs < 1_000 || this.terminationGraceMs > 60_000) {
      throw new Error('terminationGraceMs must be an integer between 1000 and 60000');
    }
    if (!Number.isInteger(this.maxDurationMs) || this.maxDurationMs < 1_000 || this.maxDurationMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('maxDurationMs must be an integer between 1000 and 604800000');
    }
    if (!Number.isInteger(this.maxTotalMessageChars) || this.maxTotalMessageChars < 1_000 || this.maxTotalMessageChars > 10_000_000) {
      throw new Error('maxTotalMessageChars must be an integer between 1000 and 10000000');
    }
    this.connectors = connectors;
    this.storage.recoverOrphanedDiscussions(isOwnerProcessAlive);
  }

  async initiateDiscussion(params: {
    driver: AgentType;
    peer: AgentType;
    topic: string;
    initialMessage: string;
    projectPath?: string;
    traceId: string;
    maxTurns?: number;
    mode?: DiscussionMode;
    sessionPolicy?: SessionPolicy;
  }): Promise<AskPeerOutput> {
    const projectPath = resolveProjectPath(params.projectPath);
    const mode = resolveDiscussionMode(params.mode);
    const maxTurns = params.maxTurns
      ?? (this.maxTurnsWasConfigured ? this.maxTurns : defaultMaxTurnsForMode(mode));
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
      throw new Error('maxTurns must be an integer between 1 and 50');
    }
    assertParticipants(params.driver, params.peer);
    const automatic = isAutomaticDiscussionMode(mode);
    if (automatic) this.ensureAutomaticConnectors(params.driver, params.peer);
    const orchestration = automatic ? 'automatic' : 'single-turn';
    assertText(params.initialMessage, 'message');
    if (params.initialMessage.length > this.maxTotalMessageChars) {
      throw new Error('Discussion message budget exceeded');
    }

    const sessionPolicy = params.sessionPolicy ?? this.sessionPolicy;
    const collaborationSession = sessionPolicy === 'fresh'
      ? this.storage.createCollaborationSession({ projectPath, policy: 'fresh' })
      : this.storage.getOrCreateCollaborationSession({ projectPath, policy: sessionPolicy });
    const discussion = this.storage.createDiscussion({
      topic: params.topic,
      driver: params.driver,
      peer: params.peer,
      projectPath,
      traceId: params.traceId,
      mode,
      maxTurns,
      collaborationSessionId: collaborationSession.id,
      orchestration,
    });

    this.audit.log({
      traceId: params.traceId,
      discussionId: discussion.id,
      action: 'discussion.created',
      agent: params.driver,
      metadata: {
        peer: params.peer,
        topic: params.topic,
        projectPath,
        mode,
        maxTurns,
        orchestration,
        sessionPolicy,
        collaborationSessionId: collaborationSession.id,
      },
    });

    const message = this.storage.createMessage({
      discussionId: discussion.id,
      sender: params.driver,
      receiver: params.peer,
      role: 'proposal',
      content: params.initialMessage,
      projectPath,
    });

    this.audit.log({
      traceId: params.traceId,
      discussionId: discussion.id,
      action: 'message.sent',
      agent: params.driver,
      metadata: { messageId: message.id, role: 'proposal' },
    });

    this.storage.updateDiscussionStatus(discussion.id, 'DISCUSSING');
    this.queueDispatch(discussion.id, params.peer);

    if (automatic) {
      if (this.asyncDispatch) {
        this.startBackgroundAutomaticDiscussion(
          discussion.id,
          params.initialMessage,
          message.id,
          params.peer,
        );
        return {
          discussionId: discussion.id,
          collaborationSessionId: collaborationSession.id,
          peer: params.peer,
          mode,
          maxTurns,
          orchestration,
          messageId: message.id,
          status: 'DISCUSSING',
          nextAction: 'WAIT',
          dispatchState: 'QUEUED',
        };
      }
      const latestResponse = await this.runAutomaticDiscussion(
        discussion.id,
        params.initialMessage,
        message.id,
        params.peer,
      );
      const current = this.storage.getDiscussion(discussion.id);
      return {
        discussionId: discussion.id,
        collaborationSessionId: collaborationSession.id,
        peer: params.peer,
        mode,
        maxTurns,
        orchestration,
        messageId: message.id,
        status: current?.status ?? 'DISCUSSING',
        nextAction: this.nextActionFor(current),
        dispatchState: current?.dispatchState ?? (latestResponse ? 'COMPLETED' : 'FAILED'),
        ...(latestResponse ? { peerResponse: latestResponse } : {}),
      };
    }

    if (this.asyncDispatch) {
      this.startBackgroundDispatch(
        discussion.id,
        params.peer,
        params.initialMessage,
        [],
        { failedMessageId: message.id, operationKind: 'peer_message' },
      );
      return {
        discussionId: discussion.id,
        collaborationSessionId: collaborationSession.id,
        peer: params.peer,
        mode,
        maxTurns,
        orchestration,
        messageId: message.id,
        status: 'DISCUSSING',
        nextAction: 'WAIT',
        dispatchState: 'QUEUED',
      };
    }
    const peerResponse = await this.dispatchToAgent(
      discussion.id,
      params.peer,
      params.initialMessage,
      [],
      { failedMessageId: message.id, operationKind: 'peer_message' },
    );
    const current = this.storage.getDiscussion(discussion.id);
    return {
      discussionId: discussion.id,
      collaborationSessionId: collaborationSession.id,
      peer: params.peer,
      mode,
      maxTurns,
      orchestration,
      messageId: message.id,
      status: current?.status ?? 'DISCUSSING',
      nextAction: this.nextActionFor(current),
      dispatchState: peerResponse ? 'COMPLETED' : 'FAILED',
      ...(peerResponse ? { peerResponse } : {}),
    };
  }

  async replyToDiscussion(params: {
    discussionId: string;
    reply: string;
    sender: AgentType;
    mode?: DiscussionMode;
  }): Promise<ReplyPeerOutput> {
    assertText(params.reply, 'message');
    const discussion = this.storage.getDiscussion(params.discussionId);
    if (!discussion) throw new Error(`Discussion ${params.discussionId} not found`);
    const resumesUserDecision = discussion.status === 'NEEDS_USER_DECISION';
    if (isTerminal(discussion.status) || (isPaused(discussion.status) && !resumesUserDecision)) {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    if (![discussion.driver, discussion.peer].includes(params.sender)) {
      throw new Error(`Agent ${params.sender} is not a participant in discussion ${params.discussionId}`);
    }
    if (discussion.orchestration === 'automatic' && this.automaticRuns.has(params.discussionId)) {
      throw new ProviderError('BUSY', `Discussion ${params.discussionId} is being automatically orchestrated`);
    }
    const requestedMode = params.mode === undefined ? undefined : resolveDiscussionMode(params.mode);
    if (requestedMode && discussionModeRank(requestedMode) < discussionModeRank(discussion.mode)) {
      throw new Error(`Discussion mode cannot be downgraded from ${discussion.mode} to ${requestedMode}`);
    }
    this.ensureNoDispatchInFlight(params.discussionId);
    this.ensureWithinBudget(discussion, params.reply);
    if (discussion.roundCount >= discussion.maxTurns) {
      this.storage.updateDiscussionStatus(params.discussionId, 'NEEDS_USER_DECISION');
      this.storage.updateDiscussionDiagnostic(params.discussionId, 'MAX_TURNS');
      this.storage.updateDiscussionDispatch(params.discussionId, 'FAILED', null);
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'discussion.max_turns',
        agent: params.sender,
        metadata: { roundCount: discussion.roundCount, maxTurns: discussion.maxTurns },
      });
      throw new Error(`Discussion ${params.discussionId} reached its provider response limit (${discussion.maxTurns})`);
    }

    const receiver = resumesUserDecision && discussion.waitingFor
      ? discussion.waitingFor
      : params.sender === discussion.driver ? discussion.peer : discussion.driver;
    const requestedAutomatic = requestedMode
      ? isAutomaticDiscussionMode(requestedMode)
      : discussion.orchestration === 'automatic';
    if (requestedAutomatic) this.ensureAutomaticConnectors(discussion.driver, discussion.peer);
    this.ensureProviderNotLeased(receiver, discussion.projectPath);
    this.storage.acquireDiscussionLease({
      discussionId: params.discussionId,
      projectPath: discussion.projectPath,
      ownerId: this.ownerId,
      ttlMs: this.timeoutMs,
    });
    let discussionLeaseOwned = true;
    try {
      if (requestedMode && requestedMode !== discussion.mode) {
        this.storage.updateDiscussionPolicy(
          params.discussionId,
          requestedMode,
          requestedAutomatic ? 'automatic' : 'single-turn',
        );
        this.audit.log({
          traceId: discussion.traceId,
          discussionId: discussion.id,
          action: 'discussion.mode_upgraded',
          agent: params.sender,
          metadata: { from: discussion.mode, to: requestedMode },
        });
      }
      const message = this.storage.createMessage({
        discussionId: params.discussionId,
        sender: params.sender,
        receiver,
        role: 'response',
        content: params.reply,
        projectPath: discussion.projectPath,
      });

      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'message.sent',
        agent: params.sender,
        metadata: { messageId: message.id, role: 'response' },
      });

      if (resumesUserDecision) {
        this.audit.log({
          traceId: discussion.traceId,
          discussionId: params.discussionId,
          action: 'discussion.user_decision_resumed',
          agent: params.sender,
          metadata: { previousStopReason: discussion.stopReason },
        });
      }

      this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
      if (resumesUserDecision) this.storage.updateDiscussionDiagnostic(params.discussionId, null);
      this.queueDispatch(params.discussionId, receiver);
      const previousMessages = this.storage.getMessages(params.discussionId).slice(0, -1);
      if (requestedAutomatic) {
        const originalRequest = previousMessages[0]?.content ?? params.reply;
        if (this.asyncDispatch) {
          this.startBackgroundAutomaticDiscussion(
            params.discussionId,
            originalRequest,
            message.id,
            receiver,
          );
          discussionLeaseOwned = false;
          return { messageId: message.id, status: 'DISCUSSING', nextAction: 'WAIT', dispatchState: 'QUEUED' };
        }
        this.storage.releaseDiscussionLease(params.discussionId, this.ownerId);
        discussionLeaseOwned = false;
        const peerResponse = await this.runAutomaticDiscussion(
          params.discussionId,
          originalRequest,
          message.id,
          receiver,
        );
        const current = this.storage.getDiscussion(params.discussionId);
        return {
          messageId: message.id,
          status: current?.status ?? 'DISCUSSING',
          nextAction: this.nextActionFor(current),
          dispatchState: current?.dispatchState ?? (peerResponse ? 'COMPLETED' : 'FAILED'),
          ...(peerResponse ? { peerResponse } : {}),
        };
      }
      if (this.asyncDispatch) {
        this.startBackgroundDispatch(
          params.discussionId,
          receiver,
          params.reply,
          previousMessages,
          {
            discussionLeaseOwned: true,
            failedMessageId: message.id,
            operationKind: 'peer_message',
          },
        );
        discussionLeaseOwned = false;
        return { messageId: message.id, status: 'DISCUSSING', nextAction: 'WAIT', dispatchState: 'QUEUED' };
      }
      const peerResponse = await this.dispatchToAgent(
        params.discussionId,
        receiver,
        params.reply,
        previousMessages,
        { discussionLeaseOwned: true, failedMessageId: message.id, operationKind: 'peer_message' },
      );
      const current = this.storage.getDiscussion(params.discussionId);
      return {
        messageId: message.id,
        status: current?.status ?? 'DISCUSSING',
        nextAction: this.nextActionFor(current),
        dispatchState: peerResponse ? 'COMPLETED' : 'FAILED',
        ...(peerResponse ? { peerResponse } : {}),
      };
    } finally {
      if (discussionLeaseOwned) this.storage.releaseDiscussionLease(params.discussionId, this.ownerId);
    }
  }

  async getDiscussion(discussionId: string): Promise<GetDiscussionOutput> {
    const discussion = this.storage.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion ${discussionId} not found`);

    return {
      discussion,
      messages: this.storage.getMessages(discussionId),
      decision: this.storage.getDecisionByDiscussion(discussionId),
      peerRuntime: this.readPeerRuntime(discussionId),
      pendingPermissions: this.storage.listPermissionRequests(discussionId, ['PENDING']),
      nextAction: this.nextActionFor(discussion),
      providerSessions: this.storage.listSessionsForDiscussion(discussionId).map((session) => ({
        provider: session.provider,
        sessionId: session.sessionId,
        kind: typeof session.metadata.sessionKind === 'string' ? session.metadata.sessionKind : null,
        status: session.status,
        lastSeenAt: session.lastSeenAt,
      })),
    };
  }

  async watchDiscussion(
    discussionId: string,
    timeoutMs = 30_000,
    afterSequence = 0,
  ): Promise<WatchDiscussionOutput> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('timeoutMs must be an integer between 1000 and 120000');
    }
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error('afterSequence must be a non-negative integer');
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const events = this.storage.getPeerRuntimeEvents(discussionId, afterSequence, 1_000);
      if (events.length > 0) {
        const snapshot = await this.getDiscussion(discussionId);
        return {
          ...snapshot,
          events,
          waitTimedOut: false,
          lastSequence: events.at(-1)?.sequence ?? afterSequence,
        };
      }
      const snapshot = await this.getDiscussion(discussionId);
      if (isTerminal(snapshot.discussion.status) || isPaused(snapshot.discussion.status)) {
        return { ...snapshot, events: [], waitTimedOut: false, lastSequence: afterSequence || null };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ...snapshot, events: [], waitTimedOut: true, lastSequence: afterSequence || null };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
  }

  listPermissionRequests(discussionId: string, includeResolved = false): PermissionRequest[] {
    return includeResolved
      ? this.storage.listPermissionRequests(discussionId)
      : this.storage.listPermissionRequests(discussionId, ['PENDING']);
  }

  resolvePermission(params: {
    permissionId: string;
    decision: PermissionDecision;
    agent?: AgentType;
  }): PermissionRequest {
    const request = this.storage.getPermissionRequest(params.permissionId);
    if (!request) throw new Error(`Permission request ${params.permissionId} not found`);
    const discussion = this.storage.getDiscussion(request.discussionId);
    if (!discussion) throw new Error(`Discussion ${request.discussionId} not found`);
    if (params.agent && ![discussion.driver, discussion.peer].includes(params.agent)) {
      throw new Error(`Agent ${params.agent} is not a participant in discussion ${discussion.id}`);
    }
    const resolved = this.storage.resolvePermissionRequest(
      request.id,
      params.decision,
      params.agent ? 'driver-policy' : 'user',
    );
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'permission.resolved',
      agent: params.agent ?? 'system',
      metadata: { permissionId: request.id, decision: params.decision, status: resolved.status },
    });
    return resolved;
  }

  private readPeerRuntime(discussionId: string): PeerRuntimeState | null {
    const runtime = this.storage.getPeerRuntime(discussionId);
    if (!runtime) return null;
    const now = Date.now();
    const elapsedMs = Math.max(0, now - runtime.startedAt);
    const idleMs = Math.max(0, now - runtime.lastActivityAt);
    let state = runtime.state;
    if (!['COMPLETED', 'FAILED', 'STALLED'].includes(state)) {
      if (state === 'STARTING' && elapsedMs >= this.startupTimeoutMs) state = 'STALLED';
      else if (state !== 'WAITING_PERMISSION' && idleMs >= this.idleTimeoutMs) {
        state = idleMs >= this.idleTimeoutMs + this.stallGraceMs && !runtime.currentTool
          ? 'STALLED'
          : 'IDLE_SUSPECTED';
      }
    }
    return { ...runtime, state, elapsedMs, idleMs };
  }

  async waitForDiscussion(
    discussionId: string,
    timeoutMs = 30_000,
    afterMessageId?: string,
  ): Promise<WaitDiscussionOutput> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('timeoutMs must be an integer between 1000 and 120000');
    }
    const deadline = Date.now() + timeoutMs;
    const initialMessages = this.storage.getMessages(discussionId);
    const wakeAfterMessageId = afterMessageId ?? initialMessages.at(-1)?.id;
    while (true) {
      const snapshot = await this.getDiscussion(discussionId);
      const lastMessageId = snapshot.messages.at(-1)?.id ?? null;
      const hasNewMessage = wakeAfterMessageId
        ? this.storage.getMessages(discussionId, wakeAfterMessageId).length > 0
        : false;
      const settled = isTerminal(snapshot.discussion.status)
        || isPaused(snapshot.discussion.status)
        || (!isAutomaticDiscussion(snapshot.discussion)
          && snapshot.discussion.dispatchState !== 'QUEUED'
          && snapshot.discussion.dispatchState !== 'RUNNING');
      if (hasNewMessage || settled) return { ...snapshot, waitTimedOut: false, lastMessageId };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...snapshot, waitTimedOut: true, lastMessageId };
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
  }

  async closeDiscussion(params: {
    discussionId: string;
    conclusion: string;
    agent: AgentType;
  }): Promise<CloseDiscussionOutput> {
    assertText(params.conclusion, 'conclusion');
    const discussion = this.storage.getDiscussion(params.discussionId);
    if (!discussion) throw new Error(`Discussion ${params.discussionId} not found`);
    if (isTerminal(discussion.status) || isPaused(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    if (![discussion.driver, discussion.peer].includes(params.agent)) {
      throw new Error(`Agent ${params.agent} is not a participant in discussion ${params.discussionId}`);
    }
    this.ensureNoDispatchInFlight(params.discussionId);

    const otherAgent = params.agent === discussion.driver ? discussion.peer : discussion.driver;
    this.ensureProviderNotLeased(otherAgent, discussion.projectPath);
    const existingConclusion = this.storage.getMessages(params.discussionId).some((message) => (
      message.sender === params.agent
      && message.receiver === otherAgent
      && message.role === 'conclusion'
      && message.content === params.conclusion
    ));
    this.ensureWithinBudget(discussion, existingConclusion ? '' : params.conclusion);

    this.storage.acquireDiscussionLease({
      discussionId: params.discussionId,
      projectPath: discussion.projectPath,
      ownerId: this.ownerId,
      ttlMs: this.timeoutMs,
    });
    let discussionLeaseOwned = true;
    try {
    const agreement = this.storage.recordAgreement({
      discussionId: params.discussionId,
      agent: params.agent,
      summary: params.conclusion,
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: params.discussionId,
      action: `agreement.${params.agent}`,
      agent: params.agent,
      metadata: { decisionHash: agreement.decisionHash },
    });

    if (agreement.agreedBy.length >= 2) {
      return this.completeDiscussion(discussion, params.conclusion, agreement.agreedBy);
    }

    if (!existingConclusion) {
      this.storage.createMessage({
        discussionId: params.discussionId,
        sender: params.agent,
        receiver: otherAgent,
        role: 'conclusion',
        content: params.conclusion,
        projectPath: discussion.projectPath,
      });
    }

    const messages = this.storage.getMessages(params.discussionId);
    const agreementPrompt = buildAgreementPrompt(params.conclusion, agreement.decisionHash);
    const conclusionMessageId = messages.find((message) => (
      message.sender === params.agent
      && message.receiver === otherAgent
      && message.role === 'conclusion'
      && message.content === params.conclusion
    ))?.id ?? null;
    this.queueDispatch(params.discussionId, otherAgent);
    if (this.asyncDispatch) {
      this.startBackgroundAgreementConfirmation(
        discussion.id,
        params.agent,
        otherAgent,
        params.conclusion,
        agreement.decisionHash,
        agreementPrompt,
        messages,
        conclusionMessageId,
      );
      discussionLeaseOwned = false;
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        waitingFor: [otherAgent],
        dispatchState: 'QUEUED',
      };
    }
    let peerResponse: Message | undefined;
    try {
      peerResponse = await this.dispatchToAgent(
        params.discussionId,
        otherAgent,
        agreementPrompt,
        messages,
        {
          updateFailureStatus: false,
          countRound: false,
          discussionLeaseOwned: true,
          applyDiscussionPolicy: false,
          failedMessageId: conclusionMessageId,
          operationKind: 'agreement_confirmation',
        },
      );
    } catch (cause) {
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'agreement.notification_failed',
        agent: otherAgent,
        metadata: { error: cause instanceof Error ? cause.message : String(cause) },
      });
    }

    if (!peerResponse) {
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        waitingFor: [otherAgent],
        dispatchState: 'FAILED',
      };
    }

    const peerDecision = parseAgreementResponse(peerResponse.content, agreement.decisionHash);
    if (!peerDecision.accepted) {
      const unresolved = peerDecision.resolution === 'user_decision';
      this.storage.updateDiscussionDispatch(params.discussionId, 'COMPLETED', unresolved ? null : params.agent);
      if (unresolved) {
        this.storage.updateDiscussionSignal(params.discussionId, 'NEEDS_USER_DECISION');
        this.storage.updateDiscussionStatus(params.discussionId, 'NEEDS_USER_DECISION');
        this.storage.updateDiscussionDiagnostic(params.discussionId, 'UNRESOLVED_DISAGREEMENT');
      }
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'agreement.rejected',
        agent: otherAgent,
        metadata: {
          reason: peerDecision.reason ?? 'invalid_or_rejected_response',
          resolution: peerDecision.resolution,
        },
      });
      return {
        discussionId: params.discussionId,
        status: unresolved ? 'NEEDS_USER_DECISION' : 'DISCUSSING',
        ...(unresolved ? {} : { waitingFor: [params.agent] }),
        peerAccepted: false,
        dispatchState: 'COMPLETED',
        peerResponse,
      };
    }

    const peerAgreement = this.storage.recordAgreement({
      discussionId: params.discussionId,
      agent: otherAgent,
      summary: params.conclusion,
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: params.discussionId,
      action: `agreement.${otherAgent}`,
      agent: otherAgent,
      metadata: { decisionHash: peerAgreement.decisionHash, source: 'connector_confirmation' },
    });
    const completed = this.completeDiscussion(discussion, params.conclusion, peerAgreement.agreedBy);
    return { ...completed, peerAccepted: true, peerResponse };
    } finally {
      if (discussionLeaseOwned) this.storage.releaseDiscussionLease(params.discussionId, this.ownerId);
    }
  }

  async cancelDiscussion(params: {
    discussionId: string;
    agent: AgentType;
  }): Promise<CancelDiscussionOutput> {
    const discussion = this.storage.getDiscussion(params.discussionId);
    if (!discussion) throw new Error(`Discussion ${params.discussionId} not found`);
    if (isTerminal(discussion.status) && discussion.status !== 'NEEDS_USER_DECISION') {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    if (![discussion.driver, discussion.peer].includes(params.agent)) {
      throw new Error(`Agent ${params.agent} is not a participant in discussion ${params.discussionId}`);
    }

    const active = this.inFlight.get(params.discussionId);
    const remoteProviderActive = !active && [discussion.driver, discussion.peer].some((provider) => (
      this.storage.hasSessionLease(provider, discussion.projectPath, discussion.id)
    ));
    this.cancellationRequests.add(params.discussionId);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'cancel.requested',
      agent: params.agent,
      metadata: { providerActive: Boolean(active) },
    });
    try {
      active?.controller.abort();
      const connectors = [this.connectors[discussion.driver], this.connectors[discussion.peer]];
      const results = await Promise.allSettled(connectors.map((connector) => connector?.cancel?.(params.discussionId)));
      const connectorFailures = results.filter((result) => result.status === 'rejected');
      const providerSettled = !remoteProviderActive
        && (!active || await waitForCompletion(active.done, Math.min(5_000, this.timeoutMs)));
      if (connectorFailures.length > 0 || !providerSettled) {
        const current = this.storage.getDiscussion(params.discussionId);
        if (current && !isTerminal(current.status) && current.status !== 'NEEDS_USER_DECISION') {
          this.storage.updateDiscussionStatus(params.discussionId, 'NEEDS_USER_DECISION');
        }
        this.storage.updateDiscussionDispatch(params.discussionId, 'FAILED', null);
        this.audit.log({
          traceId: discussion.traceId,
          discussionId: discussion.id,
          action: 'cancel.provider_unconfirmed',
          agent: params.agent,
          metadata: { connectorFailures: connectorFailures.length, providerSettled, remoteProviderActive },
        });
        throw new ProviderError('FAILED', 'Provider cancellation could not be confirmed');
      }

      this.storage.updateDiscussionStatus(params.discussionId, 'CANCELLED', {
        endedAt: new Date().toISOString(),
      });
      this.storage.updateDiscussionDispatch(params.discussionId, null, null);
      this.storage.releaseSessionLease(discussion.driver, discussion.projectPath, discussion.id);
      this.storage.releaseSessionLease(discussion.peer, discussion.projectPath, discussion.id);
      this.storage.releaseDiscussionLease(discussion.id, this.ownerId);
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: discussion.id,
        action: 'cancel.provider_confirmed',
        agent: params.agent,
        metadata: {},
      });
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: discussion.id,
        action: 'discussion.cancelled',
        agent: params.agent,
        metadata: {},
      });
      this.archiveDiscussionSessions(discussion.id);
      return { discussionId: discussion.id, status: 'CANCELLED' };
    } finally {
      this.cancellationRequests.delete(params.discussionId);
    }
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.shuttingDown) return;
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60_000) {
      throw new Error('graceMs must be an integer between 0 and 60000');
    }
    this.shuttingDown = true;
    const active = [...this.inFlight.entries()];
    for (const [discussionId, operation] of active) {
      this.cancellationRequests.add(discussionId);
      operation.controller.abort();
    }
    await Promise.allSettled(
      active.map(([discussionId]) => {
        const discussion = this.storage.getDiscussion(discussionId);
        if (!discussion) return Promise.resolve();
        const connectors = [this.connectors[discussion.driver], this.connectors[discussion.peer]];
        return Promise.allSettled(connectors.map((connector) => connector?.cancel?.(discussionId)));
      }),
    );
    const settled = await Promise.all(active.map(async ([discussionId, operation]) => ({
      discussionId,
      done: await waitForCompletion(operation.done, graceMs),
    })));
    for (const item of settled) {
      if (!item.done) continue;
      const discussion = this.storage.getDiscussion(item.discussionId);
      if (!discussion) continue;
      this.storage.releaseSessionLease(discussion.driver, discussion.projectPath, item.discussionId);
      this.storage.releaseSessionLease(discussion.peer, discussion.projectPath, item.discussionId);
      this.storage.releaseDiscussionLease(item.discussionId, this.ownerId);
    }
    for (const [discussionId] of active) this.cancellationRequests.delete(discussionId);
  }

  async retryDiscussion(params: {
    discussionId: string;
    agent: AgentType;
  }): Promise<RetryDiscussionOutput> {
    const discussion = this.storage.getDiscussion(params.discussionId);
    if (!discussion) throw new Error(`Discussion ${params.discussionId} not found`);
    if (![discussion.driver, discussion.peer].includes(params.agent)) {
      throw new Error(`Agent ${params.agent} is not a participant in discussion ${params.discussionId}`);
    }
    if (!canRetry(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} cannot be retried from ${discussion.status}`);
    }
    this.ensureNoDispatchInFlight(params.discussionId);
    const runtime = this.readPeerRuntime(params.discussionId);
    if (runtime && (
      ['STARTING', 'RUNNING', 'WAITING_TOOL', 'WAITING_PERMISSION', 'GENERATING', 'IDLE_SUSPECTED'].includes(runtime.state)
      || (runtime.state === 'STALLED' && runtime.processAlive !== false)
    )) {
      throw new Error(`Discussion ${params.discussionId} cannot retry while peer runtime is ${runtime.state} (PEER_STILL_RUNNING)`);
    }
    if (discussion.retryCount >= discussion.maxRetries) {
      throw new Error(`Discussion ${params.discussionId} exhausted its maxRetries budget`);
    }
    if (discussion.roundCount >= discussion.maxTurns) {
      throw new Error(`Discussion ${params.discussionId} exhausted its maxTurns budget`);
    }

    if (discussion.stopReason === 'PEER_REQUESTED_USER_DECISION') {
      throw new Error(
        `Discussion ${params.discussionId} requires an explicit reply_peer decision; retry_discussion cannot replay a peer decision request`,
      );
    }
    if (discussion.stopReason === 'MAX_DURATION'
      || discussion.stopReason === 'MESSAGE_BUDGET'
      || discussion.stopReason === 'MAX_TURNS') {
      throw new Error(`Discussion ${params.discussionId} cannot retry after ${discussion.stopReason}`);
    }
    if (discussion.lastError && (!discussion.lastError.retryable || discussion.lastError.ambiguous)) {
      throw new Error(
        `Discussion ${params.discussionId} cannot retry provider result (retryable=${discussion.lastError.retryable}, ambiguous=${discussion.lastError.ambiguous})`,
      );
    }

    const messages = this.storage.getMessages(params.discussionId);
    let failedMessageId = discussion.failedMessageId;
    let failedReceiver = discussion.failedDispatchReceiver;
    let failedMessage = failedMessageId
      ? messages.find((message) => message.id === failedMessageId)
      : undefined;
    const hasFailureMetadata = Boolean(
      failedMessageId || failedReceiver || discussion.failedOperationKind,
    );
    if (hasFailureMetadata) {
      const retryableOperation = discussion.failedOperationKind === 'peer_message'
        || discussion.failedOperationKind === 'automatic_turn'
        || discussion.failedOperationKind === 'agreement_confirmation';
      if (!failedMessageId || !failedReceiver || !retryableOperation) {
        throw new Error(`Discussion ${params.discussionId} has no retryable failed peer dispatch`);
      }
      if (!failedMessage || failedMessage.receiver !== failedReceiver) {
        throw new Error(`Discussion ${params.discussionId} has inconsistent failed dispatch metadata`);
      }
    } else {
      // Rows created before failed-dispatch metadata was introduced have no
      // pointer to replay. Infer only an unmistakable peer request; all
      // reason-aware retry guards above still apply.
      const legacyMessage = messages.at(-1);
      if (!legacyMessage || !isLegacyRetryablePeerMessage(legacyMessage, discussion)) {
        throw new Error(`Discussion ${params.discussionId} has no retryable failed peer dispatch`);
      }
      failedMessage = legacyMessage;
      failedMessageId = legacyMessage.id;
      failedReceiver = legacyMessage.receiver;
    }
    if (!failedMessage || !failedMessageId || !failedReceiver) {
      throw new Error(`Discussion ${params.discussionId} has inconsistent failed dispatch metadata`);
    }

    if (discussion.orchestration === 'automatic') {
      if (discussion.status === 'FAILED') this.storage.updateDiscussionStatus(params.discussionId, 'CREATED');
      this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
      this.queueDispatch(params.discussionId, failedReceiver);
      const originalRequest = messages[0]?.content ?? failedMessage.content;
      if (this.asyncDispatch) {
        this.storage.updateDiscussionPending(params.discussionId, discussion.failedOperationKind, failedMessageId);
        if (discussion.failedOperationKind === 'agreement_confirmation') {
          this.startBackgroundAutomaticAgreementRetry(params.discussionId, originalRequest, failedMessage, failedReceiver);
        } else {
          this.startBackgroundAutomaticDiscussion(params.discussionId, originalRequest, failedMessageId, failedReceiver);
        }
        return {
          discussionId: params.discussionId,
          status: 'DISCUSSING',
          retryCount: discussion.retryCount,
          dispatchState: 'QUEUED',
        };
      }
      if (discussion.failedOperationKind === 'agreement_confirmation') {
        await this.runAutomaticAgreementRetry(params.discussionId, originalRequest, failedMessage, failedReceiver);
      } else {
        await this.runAutomaticDiscussion(params.discussionId, originalRequest, failedMessageId, failedReceiver);
      }
      const resumed = this.storage.getDiscussion(params.discussionId);
      return {
        discussionId: params.discussionId,
        status: resumed?.status === 'NEEDS_USER_DECISION' ? 'NEEDS_USER_DECISION' : 'DISCUSSING',
        retryCount: discussion.retryCount,
        dispatchState: resumed?.dispatchState ?? 'FAILED',
      };
    }
    this.ensureProviderNotLeased(failedReceiver, discussion.projectPath);
    this.storage.acquireDiscussionLease({
      discussionId: params.discussionId,
      projectPath: discussion.projectPath,
      ownerId: this.ownerId,
      ttlMs: this.timeoutMs,
    });
    let discussionLeaseOwned = true;
    try {

    if (discussion.status === 'FAILED') {
      this.storage.updateDiscussionStatus(params.discussionId, 'CREATED');
    }
    this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
    this.queueDispatch(params.discussionId, failedReceiver);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.retry_requested',
      agent: params.agent,
      metadata: { retryCount: discussion.retryCount, maxRetries: discussion.maxRetries },
    });
    const previousMessages = messages.filter((message) => message.id !== failedMessageId);
    if (this.asyncDispatch) {
      this.startBackgroundDispatch(
        params.discussionId,
        failedReceiver,
        failedMessage.content,
        previousMessages,
        {
          discussionLeaseOwned: true,
          failedMessageId,
          operationKind: 'peer_message',
        },
      );
      discussionLeaseOwned = false;
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        retryCount: discussion.retryCount,
        dispatchState: 'QUEUED',
      };
    }
    const peerResponse = await this.dispatchToAgent(
      params.discussionId,
      failedReceiver,
      failedMessage.content,
      previousMessages,
      {
        discussionLeaseOwned: true,
        failedMessageId,
        operationKind: 'peer_message',
      },
    );
    const current = this.storage.getDiscussion(params.discussionId);
    return {
      discussionId: discussion.id,
      status: current?.status === 'NEEDS_USER_DECISION' ? 'NEEDS_USER_DECISION' : 'DISCUSSING',
      retryCount: discussion.retryCount,
      dispatchState: peerResponse ? 'COMPLETED' : 'FAILED',
      ...(peerResponse ? { peerResponse } : {}),
    };
    } finally {
      if (discussionLeaseOwned) this.storage.releaseDiscussionLease(params.discussionId, this.ownerId);
    }
  }

  private startBackgroundAutomaticDiscussion(
    discussionId: string,
    originalRequest: string,
    initialMessageId: string,
    receiver: AgentType,
  ): void {
    void this.runAutomaticDiscussion(discussionId, originalRequest, initialMessageId, receiver).catch(() => {
      // The provider failure and resumable step are persisted by the dispatch.
    });
  }

  private startBackgroundAutomaticAgreementRetry(
    discussionId: string,
    originalRequest: string,
    conclusionMessage: Message,
    receiver: AgentType,
  ): void {
    void this.runAutomaticAgreementRetry(discussionId, originalRequest, conclusionMessage, receiver).catch(() => {
      // The provider failure and resumable step are persisted by the dispatch.
    });
  }

  private async runAutomaticAgreementRetry(
    discussionId: string,
    originalRequest: string,
    conclusionMessage: Message,
    receiver: AgentType,
  ): Promise<void> {
    if (this.automaticRuns.has(discussionId)) {
      throw new ProviderError('BUSY', `Discussion ${discussionId} already has an automatic run`);
    }
    this.automaticRuns.add(discussionId);
    let handedOff = false;
    try {
      const discussion = this.storage.getDiscussion(discussionId);
      if (!discussion) throw new Error(`Discussion ${discussionId} not found`);
      const conclusion = conclusionMessage.content;
      this.storage.clearAgreements(discussionId);
      const agreement = this.storage.recordAgreement({
        discussionId,
        agent: conclusionMessage.sender,
        summary: conclusion,
      });
      const messages = this.storage.getMessages(discussionId);
      this.storage.updateDiscussionPending(discussionId, 'agreement_confirmation', conclusionMessage.id);
      this.storage.updateDiscussionDispatch(discussionId, 'RUNNING', receiver);
      const peerResponse = await this.dispatchToAgent(
        discussionId,
        receiver,
        buildAgreementPrompt(conclusion, agreement.decisionHash),
        messages,
        {
          applyDiscussionPolicy: false,
          countRound: false,
          failedMessageId: conclusionMessage.id,
          operationKind: 'agreement_confirmation',
        },
      );
      if (!peerResponse) return;
      const decision = parseAgreementResponse(peerResponse.content, agreement.decisionHash);
      if (decision.accepted) {
        const peerAgreement = this.storage.recordAgreement({
          discussionId,
          agent: receiver,
          summary: conclusion,
        });
        this.storage.updateDiscussionSignal(discussionId, 'READY_TO_CLOSE');
        this.completeDiscussion(discussion, conclusion, peerAgreement.agreedBy);
        return;
      }
      this.storage.clearAgreements(discussionId);
      this.storage.updateDiscussionSignal(
        discussionId,
        decision.resolution === 'user_decision' ? 'NEEDS_USER_DECISION' : 'CONTINUE',
      );
      if (decision.resolution === 'user_decision') {
        this.storage.updateDiscussionStatus(discussionId, 'NEEDS_USER_DECISION');
        this.storage.updateDiscussionDiagnostic(discussionId, 'UNRESOLVED_DISAGREEMENT');
      }
      this.audit.log({
        traceId: discussion.traceId,
        discussionId,
        action: 'agreement.rejected',
        agent: receiver,
        metadata: {
          reason: decision.reason ?? 'invalid_or_rejected_response',
          resolution: decision.resolution,
          automatic: true,
          retry: true,
        },
      });
      if (decision.resolution === 'user_decision') return;
      handedOff = true;
      await this.runAutomaticDiscussion(discussionId, originalRequest, peerResponse.id, conclusionMessage.sender);
    } finally {
      if (!handedOff) this.automaticRuns.delete(discussionId);
    }
  }

  private async runAutomaticDiscussion(
    discussionId: string,
    originalRequest: string,
    initialMessageId: string,
    initialReceiver: AgentType,
  ): Promise<Message | undefined> {
    if (this.automaticRuns.has(discussionId)) {
      throw new ProviderError('BUSY', `Discussion ${discussionId} already has an automatic run`);
    }
    this.automaticRuns.add(discussionId);
    let latestMessageId = initialMessageId;
    let receiver = initialReceiver;
    let latestMessage = this.storage.getMessages(discussionId).find((message) => message.id === latestMessageId);
    try {
      while (latestMessage) {
        const discussion = this.storage.getDiscussion(discussionId);
        if (!discussion || isTerminal(discussion.status) || isPaused(discussion.status)) return latestMessage;
        if (discussion.roundCount >= discussion.maxTurns) {
          this.stopAutomaticAtMaxTurns(discussion);
          return latestMessage;
        }

        const previousMessages = this.storage.getMessages(discussionId)
          .filter((message) => message.id !== latestMessageId);
        const prompt = buildAutomaticTurnPrompt({
          mode: discussion.mode,
          completedResponses: discussion.roundCount,
          maxTurns: discussion.maxTurns,
          originalRequest,
          latestMessage: latestMessage.content,
          latestSender: latestMessage.sender,
        });
        this.storage.updateDiscussionPending(discussionId, 'automatic_turn', latestMessageId);
        this.storage.updateDiscussionDispatch(discussionId, 'RUNNING', receiver);
        const response = await this.dispatchToAgent(
          discussionId,
          receiver,
          prompt,
          previousMessages,
          {
            applyDiscussionPolicy: false,
            failedMessageId: latestMessageId,
            operationKind: 'automatic_turn',
          },
        );
        if (!response) {
          const failed = this.storage.getDiscussion(discussionId);
          if (failed?.status === 'DISCUSSING') this.storage.updateDiscussionStatus(discussionId, 'FAILED');
          return latestMessage;
        }

        latestMessage = response;
        latestMessageId = response.id;
        this.storage.updateDiscussionPending(discussionId, null, null);
        const rawSignal = parseDiscussionSignal(response.content);
        const afterResponse = this.storage.getDiscussion(discussionId);
        if (!afterResponse) return response;

        if (rawSignal === 'NEEDS_USER_DECISION') {
          this.storage.updateDiscussionSignal(discussionId, rawSignal);
          this.storage.updateDiscussionStatus(discussionId, 'NEEDS_USER_DECISION');
          this.storage.updateDiscussionDiagnostic(discussionId, 'PEER_REQUESTED_USER_DECISION');
          this.storage.updateDiscussionDispatch(discussionId, 'COMPLETED', receiver);
          return response;
        }

        const mayConverge = rawSignal === 'READY_TO_CLOSE';
        if (mayConverge) {
          const confirmation = await this.confirmAutomaticConclusion(afterResponse, response);
          if (confirmation.accepted) return confirmation.response ?? response;
          if (confirmation.resolution === 'user_decision') {
            return confirmation.response ?? response;
          }
          if (confirmation.response) {
            latestMessage = confirmation.response;
            latestMessageId = confirmation.response.id;
          }
          receiver = response.sender;
          continue;
        }

        this.storage.updateDiscussionSignal(discussionId, rawSignal);
        if (afterResponse.roundCount >= afterResponse.maxTurns) {
          this.stopAutomaticAtMaxTurns(afterResponse);
          return response;
        }
        receiver = oppositeAgent(receiver);
        this.storage.updateDiscussionDispatch(discussionId, 'RUNNING', receiver);
      }
      return latestMessage;
    } finally {
      this.storage.updateDiscussionPending(discussionId, null, null);
      this.automaticRuns.delete(discussionId);
    }
  }

  private async confirmAutomaticConclusion(
    discussion: Discussion,
    candidate: Message,
  ): Promise<{ accepted: boolean; response?: Message; resolution?: AgreementResolution }> {
    const conclusion = stripDiscussionSignal(candidate.content);
    if (!conclusion) return { accepted: false };
    const otherAgent = oppositeAgent(candidate.sender);
    this.storage.clearAgreements(discussion.id);
    const agreement = this.storage.recordAgreement({
      discussionId: discussion.id,
      agent: candidate.sender,
      summary: conclusion,
    });
    const conclusionMessage = this.storage.createMessage({
      discussionId: discussion.id,
      sender: candidate.sender,
      receiver: otherAgent,
      role: 'conclusion',
      content: conclusion,
      parentMessageId: candidate.id,
      projectPath: discussion.projectPath,
    });
    const messages = this.storage.getMessages(discussion.id);
    const agreementPrompt = buildAgreementPrompt(conclusion, agreement.decisionHash);
    this.storage.updateDiscussionPending(discussion.id, 'agreement_confirmation', conclusionMessage.id);
    this.storage.updateDiscussionDispatch(discussion.id, 'RUNNING', otherAgent);
    const peerResponse = await this.dispatchToAgent(
      discussion.id,
      otherAgent,
      agreementPrompt,
      messages,
      {
        applyDiscussionPolicy: false,
        countRound: false,
        failedMessageId: conclusionMessage.id,
        operationKind: 'agreement_confirmation',
      },
    );
    if (!peerResponse) return { accepted: false };
    const decision = parseAgreementResponse(peerResponse.content, agreement.decisionHash);
    if (!decision.accepted) {
      this.storage.clearAgreements(discussion.id);
      this.storage.updateDiscussionSignal(discussion.id, decision.resolution === 'user_decision' ? 'NEEDS_USER_DECISION' : 'CONTINUE');
      if (decision.resolution === 'user_decision') {
        this.storage.updateDiscussionStatus(discussion.id, 'NEEDS_USER_DECISION');
        this.storage.updateDiscussionDiagnostic(discussion.id, 'UNRESOLVED_DISAGREEMENT');
      }
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: discussion.id,
        action: 'agreement.rejected',
        agent: otherAgent,
        metadata: {
          reason: decision.reason ?? 'invalid_or_rejected_response',
          resolution: decision.resolution,
          automatic: true,
        },
      });
      return { accepted: false, response: peerResponse, resolution: decision.resolution };
    }
    const peerAgreement = this.storage.recordAgreement({
      discussionId: discussion.id,
      agent: otherAgent,
      summary: conclusion,
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: `agreement.${otherAgent}`,
      agent: otherAgent,
      metadata: { decisionHash: peerAgreement.decisionHash, source: 'automatic_confirmation' },
    });
    this.storage.updateDiscussionSignal(discussion.id, 'READY_TO_CLOSE');
    this.completeDiscussion(discussion, conclusion, peerAgreement.agreedBy);
    return { accepted: true, response: peerResponse };
  }

  private stopAutomaticAtMaxTurns(discussion: Discussion): void {
    if (discussion.status === 'DISCUSSING') {
      this.storage.updateDiscussionStatus(discussion.id, 'NEEDS_USER_DECISION');
    }
    this.storage.updateDiscussionDiagnostic(discussion.id, 'MAX_TURNS');
    this.storage.updateDiscussionDispatch(discussion.id, 'FAILED', null);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.max_turns',
      agent: 'system',
      metadata: { roundCount: discussion.roundCount, maxTurns: discussion.maxTurns },
    });
  }

  private nextActionFor(discussion: Discussion | null): DiscussionNextAction {
    if (!discussion || isTerminal(discussion.status)) return 'NONE';
    if (discussion.status === 'NEEDS_USER_DECISION') return 'PROVIDE_USER_DECISION';
    if (isPaused(discussion.status)) return 'RETRY';
    if (discussion.dispatchState === 'QUEUED' || discussion.dispatchState === 'RUNNING') return 'WAIT';
    if (isAutomaticDiscussion(discussion)) return 'WAIT';
    return discussion.status === 'DISCUSSING' ? 'REPLY' : 'NONE';
  }

  private ensureAutomaticConnectors(driver: AgentType, peer: AgentType): void {
    const missing = [driver, peer].filter((agent) => !this.connectors[agent]);
    if (missing.length === 0) return;
    throw new ProviderError(
      'UNAVAILABLE',
      `Automatic discussion requires configured connectors for: ${missing.join(', ')}`,
      { backend: missing[0] },
    );
  }

  private async dispatchToAgent(
    discussionId: string,
    receiver: AgentType,
    prompt: string,
    previousMessages: Message[],
    options: {
      updateFailureStatus?: boolean;
      countRound?: boolean;
      discussionLeaseOwned?: boolean;
      applyDiscussionPolicy?: boolean;
      failedMessageId?: string | null;
      operationKind?: DiscussionOperationKind;
    } = {},
  ): Promise<Message | undefined> {
    const connector = this.connectors[receiver];
    const discussion = this.storage.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion ${discussionId} not found`);
    if (this.shuttingDown) {
      this.storage.updateDiscussionDispatch(discussionId, 'FAILED', null);
      if (options.discussionLeaseOwned) this.storage.releaseDiscussionLease(discussionId, this.ownerId);
      throw new ProviderError('CANCELLED', 'Collaboration service is shutting down');
    }
    if (this.inFlight.has(discussionId)) {
      throw new ProviderError('BUSY', `Discussion ${discussionId} already has a provider request in flight`);
    }
    const controller = new AbortController();
    const dispatchId = `dsp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let resolveDone!: () => void;
    const operation: InFlightOperation = {
      controller,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      resolveDone: () => resolveDone(),
    };
    let leaseAcquired = false;
    let discussionLeaseAcquired = options.discussionLeaseOwned === true;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let runtimeMonitor: ReturnType<typeof setInterval> | undefined;
    let trackedSession: { sessionId: string; metadata: Record<string, unknown> } | undefined;
    let providerPromise: Promise<PeerResponse> | undefined;
    let terminationConfirmed = true;
    let sessionLeaseFailureLogged = false;
    let discussionLeaseFailureLogged = false;
    this.inFlight.set(discussionId, operation);
    try {
      if (!discussionLeaseAcquired) {
        this.storage.acquireDiscussionLease({
          discussionId,
          projectPath: discussion.projectPath,
          ownerId: this.ownerId,
          ttlMs: this.timeoutMs,
        });
        discussionLeaseAcquired = true;
      }
      this.storage.updateDiscussionDispatch(discussionId, 'RUNNING', receiver);
      const startedAt = Date.now();
      this.storage.upsertPeerRuntime({
        discussionId,
        dispatchId,
        provider: receiver,
        state: 'STARTING',
        startedAt,
        lastActivityAt: startedAt,
        processAlive: undefined,
        connectionAlive: undefined,
        sessionAlive: undefined,
        elapsedMs: 0,
        idleMs: 0,
      });
      runtimeMonitor = setInterval(() => {
        this.monitorPeerRuntime(discussionId, dispatchId, controller);
      }, Math.max(250, Math.min(1_000, Math.floor(this.idleTimeoutMs / 4))));
      runtimeMonitor.unref?.();
      if (!connector) {
        this.updatePeerRuntime(discussionId, dispatchId, { state: 'FAILED', processAlive: false, connectionAlive: false });
        this.storage.updateDiscussionDispatch(discussionId, 'FAILED', null);
        this.storage.updateDiscussionDiagnostic(discussionId, 'PROVIDER_ERROR', {
          code: 'UNAVAILABLE',
          message: `${receiver} connector is not configured`,
          backend: receiver,
          retryable: true,
          ambiguous: false,
          at: new Date().toISOString(),
        });
        this.storage.updateDiscussionFailure(discussionId, {
          receiver,
          messageId: options.failedMessageId ?? null,
          operationKind: options.operationKind ?? null,
        });
        return undefined;
      }
      if (!(await connector.isAvailable())) {
        throw new ProviderError('UNAVAILABLE', `${receiver} connector is not available`);
      }
      if (await connector.isBusy()) {
        throw new ProviderError('BUSY', `${receiver} session is busy`);
      }
      this.storage.acquireSessionLease({
        provider: receiver,
        projectPath: discussion.projectPath,
        ownerId: discussionId,
        ttlMs: this.timeoutMs,
      });
      leaseAcquired = true;
      leaseHeartbeat = setInterval(() => {
        try {
          if (!this.storage.renewSessionLease(receiver, discussion.projectPath, discussionId, this.timeoutMs)) {
            if (!sessionLeaseFailureLogged) {
              sessionLeaseFailureLogged = true;
              this.audit.log({
                traceId: discussion.traceId,
                discussionId,
                action: 'lease.session_renew_failed',
                agent: receiver,
                metadata: { provider: receiver, ownerId: discussionId, projectPath: discussion.projectPath },
              });
            }
            controller.abort();
          }
          if (!this.storage.renewDiscussionLease(discussionId, this.ownerId, this.timeoutMs)) {
            if (!discussionLeaseFailureLogged) {
              discussionLeaseFailureLogged = true;
              this.audit.log({
                traceId: discussion.traceId,
                discussionId,
                action: 'lease.discussion_renew_failed',
                agent: 'system',
                metadata: { ownerId: this.ownerId, projectPath: discussion.projectPath },
              });
            }
            controller.abort();
          }
        } catch (cause) {
          this.audit.log({
            traceId: discussion.traceId,
            discussionId,
            action: 'lease.storage_error',
            agent: 'system',
            metadata: { provider: receiver, ownerId: this.ownerId, error: redactDiagnostic(cause instanceof Error ? cause.message : String(cause)) },
          });
          controller.abort();
        }
      }, Math.max(1_000, Math.floor(this.timeoutMs / 3)));
      leaseHeartbeat.unref?.();

      const collaborationSession = discussion.collaborationSessionId
        ? this.storage.getCollaborationSession(discussion.collaborationSessionId)
        : null;
      const persistedSession = collaborationSession
        ? this.storage.getSessionForCollaboration(receiver, collaborationSession.id, discussion.projectPath)
        : !collaborationSession
          ? this.storage.getSessionForDiscussion(receiver, discussionId, discussion.projectPath)
          : null;
      if (persistedSession) {
        trackedSession = { sessionId: persistedSession.sessionId, metadata: persistedSession.metadata };
        this.storage.updateSessionStatus(receiver, persistedSession.sessionId, 'BRIDGE_OWNED', {
          ...persistedSession.metadata,
          bridgeOwned: true,
          discussionId,
          ...(collaborationSession ? { collaborationSessionId: collaborationSession.id } : {}),
        });
      }
    const providerSessionKind = readProviderSessionKind(persistedSession?.metadata.sessionKind);
      const completedResponses = discussion.roundCount;
      const effectivePrompt = options.applyDiscussionPolicy === false
        ? prompt
        : buildDiscussionPrompt({
            mode: discussion.mode,
            completedResponses,
            maxTurns: discussion.maxTurns,
            prompt,
          });
      providerPromise = connector.sendAndWait({
          projectPath: discussion.projectPath,
          prompt: effectivePrompt,
          discussionId,
          dispatchId,
          previousMessages,
          providerSessionId: persistedSession?.sessionId,
          providerSessionKind,
          signal: controller.signal,
          onActivity: (activity) => this.recordPeerActivity(discussionId, dispatchId, activity),
          onPermissionRequest: (request) => this.requestPeerPermission(request, controller.signal),
        });
      const response = await withTimeout(
        providerPromise,
        this.turnHardLimitMs,
        () => {
          this.updatePeerRuntime(discussionId, dispatchId, { state: 'STALLED' });
          controller.abort();
        },
      );

      if (controller.signal.aborted) {
        throw new ProviderError('CANCELLED', `Peer ${receiver} request was cancelled`);
      }

      this.updatePeerRuntime(discussionId, dispatchId, {
        state: 'COMPLETED',
        lastActivityAt: Date.now(),
        processAlive: false,
        connectionAlive: false,
      });

      this.ensureWithinBudget(discussion, response.content);

      if (response.availability) {
        this.audit.log({
          traceId: discussion.traceId,
          discussionId,
          action: 'peer.availability',
          agent: receiver,
          metadata: { availability: response.availability },
        });
      }

      const providerSessionId = response.providerSessionId;
      if (providerSessionId) {
        this.storage.registerSession({
          provider: receiver,
          sessionId: providerSessionId,
          projectPath: discussion.projectPath,
          status: 'IDLE',
          metadata: {
            discussionId,
            bridgeOwned: true,
            availability: response.availability ?? 'BACKGROUND',
            sessionKind: response.providerSessionKind,
            ...(collaborationSession ? { collaborationSessionId: collaborationSession.id } : {}),
          },
        });
        if (collaborationSession) {
          this.storage.bindProviderSession({
            collaborationSessionId: collaborationSession.id,
            provider: receiver,
            sessionId: providerSessionId,
          });
        }
      }

      const message = this.storage.createMessage({
        discussionId,
        sender: receiver,
        receiver: receiver === discussion.driver ? discussion.peer : discussion.driver,
        role: 'response',
        content: response.content,
        projectPath: discussion.projectPath,
        providerSessionId,
      });
      if (options.countRound !== false) this.storage.incrementDiscussionRound(discussionId);
      if (response.backendSwitched) {
        this.audit.log({
          traceId: discussion.traceId,
          discussionId,
          action: 'peer.backend_switched',
          agent: receiver,
          metadata: response.backendSwitched,
        });
      }
      if (trackedSession) {
        const sameSession = providerSessionId === trackedSession.sessionId
          && (!response.providerSessionKind || response.providerSessionKind === providerSessionKind);
        if (!providerSessionId) {
          this.storage.updateSessionStatus(receiver, trackedSession.sessionId, 'IDLE', trackedSession.metadata);
        } else if (!sameSession) {
          this.storage.updateSessionStatus(receiver, trackedSession.sessionId, 'UNKNOWN', {
            ...trackedSession.metadata,
            supersededBy: providerSessionId,
          });
        }
      }
      const signal = options.applyDiscussionPolicy === false ? null : parseDiscussionSignal(response.content);
      if (options.applyDiscussionPolicy !== false) {
        this.storage.updateDiscussionSignal(discussionId, signal);
      }
      const currentAfterResponse = this.storage.getDiscussion(discussionId);
      if (currentAfterResponse?.status === 'PEER_BUSY') {
        this.storage.updateDiscussionStatus(discussionId, 'DISCUSSING');
      }
      if (signal === 'NEEDS_USER_DECISION') {
        const current = this.storage.getDiscussion(discussionId);
        if (current?.status === 'DISCUSSING') {
          this.storage.updateDiscussionStatus(discussionId, 'NEEDS_USER_DECISION');
          this.storage.updateDiscussionDiagnostic(discussionId, 'PEER_REQUESTED_USER_DECISION');
        }
      }
      this.storage.updateDiscussionDispatch(discussionId, 'COMPLETED', null);
      this.storage.updateDiscussionFailure(discussionId, {
        receiver: null,
        messageId: null,
        operationKind: null,
      });
      this.audit.log({
        traceId: discussion.traceId,
        discussionId,
        action: 'peer.response',
        agent: receiver,
        metadata: {
          messageId: message.id,
          duration: response.duration,
          mode: discussion.mode,
          phase: discussionPhase(discussion.mode, completedResponses),
          signal,
        },
      });
      return message;
    } catch (cause) {
      if (providerPromise) {
        terminationConfirmed = await waitForCompletion(providerPromise, this.terminationGraceMs);
        if (!terminationConfirmed) {
          this.updatePeerRuntime(discussionId, dispatchId, {
            state: 'STALLED',
            processAlive: true,
            connectionAlive: true,
          });
        }
      }
      const runtime = this.storage.getPeerRuntime(discussionId);
      if (runtime && runtime.dispatchId === dispatchId && runtime.state !== 'STALLED' && terminationConfirmed) {
        this.updatePeerRuntime(discussionId, dispatchId, { state: 'FAILED' });
      }
      try {
        const beforeFailure = this.storage.getDiscussion(discussionId);
        this.storage.updateDiscussionDispatch(discussionId, 'FAILED', null);
        if (beforeFailure?.status === 'DISCUSSING') {
          this.storage.updateDiscussionDiagnostic(
            discussionId,
            'PROVIDER_ERROR',
            diagnosticFromError(cause, receiver, trackedSession?.metadata.sessionKind),
          );
        }
        this.storage.updateDiscussionFailure(discussionId, {
          receiver,
          messageId: options.failedMessageId ?? null,
          operationKind: options.operationKind ?? null,
        });
      } catch {
        // Preserve the provider error if persistence is unavailable during failure handling.
      }
      this.audit.log({
        traceId: discussion.traceId,
        discussionId,
        action: 'error',
        agent: receiver,
        metadata: { error: cause instanceof Error ? cause.message : String(cause) },
      });
      const current = this.storage.getDiscussion(discussionId);
      if (trackedSession) {
        try {
          this.storage.updateSessionStatus(receiver, trackedSession.sessionId, 'UNKNOWN', {
            ...trackedSession.metadata,
            lastError: cause instanceof Error ? cause.message : String(cause),
          });
        } catch {
          // The provider may have removed the session while the request failed.
        }
      }
      if (options.updateFailureStatus !== false && current && current.status === 'DISCUSSING') {
        const nextStatus = controller.signal.aborted && this.cancellationRequests.has(discussionId)
          ? 'CANCELLED'
          : classifyFailure(cause);
        if (nextStatus === 'PEER_BUSY') {
          this.audit.log({
            traceId: discussion.traceId,
            discussionId,
            action: 'session.busy',
            agent: receiver,
            metadata: { error: cause instanceof Error ? cause.message : String(cause) },
          });
        }
        if (nextStatus === 'CANCELLED' && this.cancellationRequests.has(discussionId)) {
          // cancelDiscussion waits for this operation and owns the final state.
        } else if (nextStatus === 'FAILED') {
          this.storage.incrementRetry(discussionId);
        } else {
          this.storage.updateDiscussionStatus(discussionId, nextStatus);
        }
      }
      throw cause;
    } finally {
      if (runtimeMonitor) clearInterval(runtimeMonitor);
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (terminationConfirmed && leaseAcquired) this.storage.releaseSessionLease(receiver, discussion.projectPath, discussionId);
      if (terminationConfirmed && discussionLeaseAcquired) this.storage.releaseDiscussionLease(discussionId, this.ownerId);
      operation.resolveDone();
      if (this.inFlight.get(discussionId) === operation) this.inFlight.delete(discussionId);
    }
  }

  private updatePeerRuntime(
    discussionId: string,
    dispatchId: string,
    patch: Partial<PeerRuntimeState>,
  ): void {
    const current = this.storage.getPeerRuntime(discussionId);
    if (!current || current.dispatchId !== dispatchId) return;
    const merged = { ...current, ...patch };
    const now = Date.now();
    this.storage.upsertPeerRuntime({
      ...merged,
      elapsedMs: Math.max(0, now - merged.startedAt),
      idleMs: Math.max(0, now - merged.lastActivityAt),
    });
  }

  private async requestPeerPermission(
    request: PeerPermissionRequestInput,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const permission = this.storage.createPermissionRequest(request);
    const runtime = this.storage.getPeerRuntime(request.discussionId);
    this.updatePeerRuntime(request.discussionId, request.dispatchId, {
      state: 'WAITING_PERMISSION',
      currentTool: request.actionType,
    });
    if (runtime) {
      this.storage.appendPeerRuntimeEvent({
        discussionId: request.discussionId,
        dispatchId: request.dispatchId,
        provider: runtime.provider,
        type: 'permission_requested',
        publicSummary: `Permission requested for ${request.actionType}`,
        metadata: {
          permissionId: permission.id,
          method: request.method,
          actionType: request.actionType,
          command: request.command,
          paths: request.paths,
          risk: request.risk ?? 'unknown',
        },
      });
    }
    const deadline = Date.now() + this.permissionTimeoutMs;
    while (Date.now() < deadline) {
      const current = this.storage.getPermissionRequest(permission.id);
      if (current?.status === 'APPROVED' || current?.status === 'DENIED' || current?.status === 'EXPIRED') {
        this.updatePeerRuntime(request.discussionId, request.dispatchId, {
          state: 'RUNNING',
          currentTool: undefined,
          lastActivityAt: Date.now(),
        });
        if (runtime) {
          this.storage.appendPeerRuntimeEvent({
            discussionId: request.discussionId,
            dispatchId: request.dispatchId,
            provider: runtime.provider,
            type: 'permission_resolved',
            publicSummary: `Permission ${current.status.toLowerCase()}`,
            metadata: { permissionId: current.id, decision: current.decision, status: current.status },
          });
        }
        return current.status === 'APPROVED' ? 'approve' : 'deny';
      }
      if (signal?.aborted) {
        const denied = this.storage.resolvePermissionRequest(permission.id, 'deny', 'user');
        this.updatePeerRuntime(request.discussionId, request.dispatchId, { state: 'RUNNING', currentTool: undefined });
        this.storage.appendPeerRuntimeEvent({
          discussionId: request.discussionId,
          dispatchId: request.dispatchId,
          provider: runtime?.provider ?? request.provider,
          type: 'permission_resolved',
          publicSummary: 'Permission denied because the dispatch was cancelled',
          metadata: { permissionId: denied.id, decision: 'deny', status: denied.status },
        });
        return 'deny';
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const expired = this.storage.expirePermissionRequest(permission.id);
    this.updatePeerRuntime(request.discussionId, request.dispatchId, { state: 'RUNNING', currentTool: undefined });
    this.storage.appendPeerRuntimeEvent({
      discussionId: request.discussionId,
      dispatchId: request.dispatchId,
      provider: runtime?.provider ?? request.provider,
      type: 'permission_resolved',
      publicSummary: 'Permission request expired',
      metadata: { permissionId: expired.id, decision: 'deny', status: expired.status },
    });
    return 'deny';
  }

  private recordPeerActivity(
    discussionId: string,
    dispatchId: string,
    activity: PeerActivity,
  ): void {
    const current = this.storage.getPeerRuntime(discussionId);
    if (!current || current.dispatchId !== dispatchId) return;
    if (['COMPLETED', 'FAILED'].includes(current.state)) return;
    const at = activity.at ?? Date.now();
    let state: PeerRuntimePhase = current.state;
    switch (activity.kind) {
      case 'process_started':
        state = 'STARTING';
        break;
      case 'provider_event':
      case 'turn_started':
        state = 'RUNNING';
        break;
      case 'output':
        state = 'GENERATING';
        break;
      case 'tool_started':
        state = 'WAITING_TOOL';
        break;
      case 'tool_completed':
        state = 'RUNNING';
        break;
      case 'process_exited':
        state = current.state === 'STALLED' ? 'STALLED' : 'FAILED';
        break;
      case 'turn_completed':
      case 'process_heartbeat':
        break;
    }
    if (current.state === 'STALLED') state = 'STALLED';
    const patch: Partial<PeerRuntimeState> = {
      state,
      ...(activity.kind === 'process_heartbeat' ? {} : { lastActivityAt: at }),
      ...(activity.kind === 'provider_event' || activity.kind.startsWith('turn_')
        ? { lastProviderEventAt: at }
        : {}),
      ...(activity.kind === 'output' ? { lastOutputAt: at } : {}),
      ...(activity.kind === 'tool_started' ? { lastToolStartedAt: at } : {}),
      ...(activity.kind === 'tool_completed' ? { currentTool: undefined } : {}),
      ...(activity.currentTool !== undefined ? { currentTool: activity.currentTool } : {}),
      ...(activity.processAlive !== undefined ? { processAlive: activity.processAlive } : {}),
      ...(activity.connectionAlive !== undefined ? { connectionAlive: activity.connectionAlive } : {}),
      ...(activity.sessionAlive !== undefined ? { sessionAlive: activity.sessionAlive } : {}),
    };
    this.updatePeerRuntime(discussionId, dispatchId, patch);
    const eventType: PeerRuntimeEvent['type'] = activity.kind === 'output'
      ? 'agent_message_delta'
      : activity.kind === 'tool_completed'
        ? 'tool_finished'
        : activity.kind === 'process_heartbeat'
          ? 'process_heartbeat'
          : activity.kind;
    try {
      this.storage.appendPeerRuntimeEvent({
        discussionId,
        dispatchId,
        provider: current.provider,
        type: eventType,
        publicSummary: activity.detail,
        metadata: {
          currentTool: activity.currentTool,
          processAlive: activity.processAlive,
          connectionAlive: activity.connectionAlive,
          sessionAlive: activity.sessionAlive,
          detail: activity.detail,
        },
      });
    } catch {
      // Runtime event persistence must not break the provider transport.
    }
  }

  private monitorPeerRuntime(
    discussionId: string,
    dispatchId: string,
    controller: AbortController,
  ): void {
    const current = this.storage.getPeerRuntime(discussionId);
    if (!current || current.dispatchId !== dispatchId) return;
    if (['COMPLETED', 'FAILED'].includes(current.state)) return;
    if (current.state === 'STALLED') return;
    const now = Date.now();
    const elapsedMs = now - current.startedAt;
    const idleMs = now - current.lastActivityAt;
    let nextState: PeerRuntimePhase = current.state;
    let shouldAbort = false;
    if (current.processAlive === false) {
      nextState = 'FAILED';
      shouldAbort = true;
    } else if (elapsedMs >= this.turnHardLimitMs) {
      nextState = 'STALLED';
      shouldAbort = true;
    } else if (current.state === 'STARTING' && elapsedMs >= this.startupTimeoutMs) {
      nextState = 'STALLED';
      shouldAbort = true;
    } else if (current.state !== 'WAITING_PERMISSION' && idleMs >= this.idleTimeoutMs) {
      nextState = idleMs >= this.idleTimeoutMs + this.stallGraceMs && !current.currentTool
        ? 'STALLED'
        : 'IDLE_SUSPECTED';
      shouldAbort = nextState === 'STALLED';
    }
    if (nextState !== current.state) this.updatePeerRuntime(discussionId, dispatchId, { state: nextState });
    if (shouldAbort && !controller.signal.aborted) controller.abort();
  }

  private ensureNoDispatchInFlight(discussionId: string): void {
    if (this.inFlight.has(discussionId)) {
      throw new ProviderError('BUSY', `Discussion ${discussionId} already has a provider request in flight`);
    }
  }

  private ensureProviderNotLeased(provider: AgentType, projectPath: string): void {
    if (this.storage.hasSessionLease(provider, projectPath)) {
      throw new SessionBusyError(`Session for ${provider} is already leased for project ${projectPath}`);
    }
  }

  private startBackgroundDispatch(
    discussionId: string,
    receiver: AgentType,
    prompt: string,
    previousMessages: Message[],
    options: {
      updateFailureStatus?: boolean;
      countRound?: boolean;
      discussionLeaseOwned?: boolean;
      applyDiscussionPolicy?: boolean;
      failedMessageId?: string | null;
      operationKind?: DiscussionOperationKind;
    } = {},
  ): void {
    void this.dispatchToAgent(discussionId, receiver, prompt, previousMessages, options).catch(() => {
      // dispatchToAgent persists and audits the failure; the caller already
      // received an accepted asynchronous request.
    });
  }

  private queueDispatch(discussionId: string, receiver: AgentType): void {
    this.storage.updateDiscussionDiagnostic(discussionId, null, null);
    this.storage.updateDiscussionDispatch(discussionId, 'QUEUED', receiver);
  }

  private startBackgroundAgreementConfirmation(
    discussionId: string,
    agent: AgentType,
    otherAgent: AgentType,
    conclusion: string,
    decisionHash: string,
    prompt: string,
    previousMessages: Message[],
    failedMessageId: string | null,
  ): void {
    void this.dispatchToAgent(
      discussionId,
      otherAgent,
      prompt,
      previousMessages,
      {
        updateFailureStatus: false,
        countRound: false,
        discussionLeaseOwned: true,
        applyDiscussionPolicy: false,
        failedMessageId,
        operationKind: 'agreement_confirmation',
      },
    ).then((peerResponse) => {
      if (!peerResponse) return;
      const decision = parseAgreementResponse(peerResponse.content, decisionHash);
      const discussion = this.storage.getDiscussion(discussionId);
      if (!discussion || isTerminal(discussion.status) || isPaused(discussion.status)) return;
      if (!decision.accepted) {
        this.storage.updateDiscussionDispatch(discussionId, 'COMPLETED', agent);
        this.audit.log({
          traceId: discussion.traceId,
          discussionId,
          action: 'agreement.rejected',
          agent: otherAgent,
          metadata: { reason: decision.reason ?? 'invalid_or_rejected_response' },
        });
        return;
      }
      const peerAgreement = this.storage.recordAgreement({
        discussionId,
        agent: otherAgent,
        summary: conclusion,
      });
      this.audit.log({
        traceId: discussion.traceId,
        discussionId,
        action: `agreement.${otherAgent}`,
        agent: otherAgent,
        metadata: { decisionHash: peerAgreement.decisionHash, source: 'connector_confirmation' },
      });
      this.completeDiscussion(discussion, conclusion, peerAgreement.agreedBy);
    }).catch((cause) => {
      const discussion = this.storage.getDiscussion(discussionId);
      this.audit.log({
        traceId: discussion?.traceId ?? `tr_${discussionId}`,
        discussionId,
        action: 'agreement.notification_failed',
        agent: agent === otherAgent ? discussion?.driver ?? otherAgent : otherAgent,
        metadata: { error: cause instanceof Error ? cause.message : String(cause) },
      });
    });
  }

  private ensureWithinBudget(discussion: {
    id: string;
    createdAt: string;
    status: string;
  }, extraContent = ''): void {
    const elapsed = Date.now() - Date.parse(discussion.createdAt);
    if (elapsed > this.maxDurationMs) {
      this.storage.updateDiscussionStatus(discussion.id, 'TIMEOUT', { endedAt: new Date().toISOString() });
      this.storage.updateDiscussionDiagnostic(discussion.id, 'MAX_DURATION');
      this.audit.log({
        traceId: this.storage.getDiscussion(discussion.id)?.traceId ?? `tr_${discussion.id}`,
        discussionId: discussion.id,
        action: 'discussion.timeout',
        agent: 'system',
        metadata: { reason: 'max_duration', maxDurationMs: this.maxDurationMs },
      });
      throw new Error(`Discussion ${discussion.id} exceeded max duration`);
    }
    const currentLength = this.storage.getMessages(discussion.id)
      .reduce((total, message) => total + message.content.length, 0);
    if (currentLength + extraContent.length > this.maxTotalMessageChars) {
      this.storage.updateDiscussionStatus(discussion.id, 'TIMEOUT', { endedAt: new Date().toISOString() });
      this.storage.updateDiscussionDiagnostic(discussion.id, 'MESSAGE_BUDGET');
      this.audit.log({
        traceId: this.storage.getDiscussion(discussion.id)?.traceId ?? `tr_${discussion.id}`,
        discussionId: discussion.id,
        action: 'discussion.timeout',
        agent: 'system',
        metadata: { reason: 'max_total_message_chars', maxTotalMessageChars: this.maxTotalMessageChars },
      });
      throw new Error(`Discussion ${discussion.id} exceeded message budget`);
    }
  }

  private completeDiscussion(
    discussion: { id: string; status: string; traceId: string },
    conclusion: string,
    agreedBy: AgentType[],
  ): CloseDiscussionOutput {
    if (discussion.status !== 'AGREED') {
      this.storage.updateDiscussionStatus(discussion.id, 'AGREED');
    }
    const decision = this.storage.getDecisionByDiscussion(discussion.id) ?? this.storage.createDecision({
      discussionId: discussion.id,
      summary: conclusion,
      changes: [],
      agreedBy,
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'decision.created',
      agent: 'system',
      metadata: { decisionId: decision.id, decisionHash: decision.decisionHash },
    });
    this.storage.updateDiscussionStatus(discussion.id, 'COMPLETED', {
      conclusion,
      endedAt: new Date().toISOString(),
    });
    this.storage.updateDiscussionDispatch(discussion.id, null, null);
    this.storage.releaseSessionLease('claude', this.storage.getDiscussion(discussion.id)!.projectPath, discussion.id);
    this.storage.releaseSessionLease('codex', this.storage.getDiscussion(discussion.id)!.projectPath, discussion.id);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.closed',
      agent: 'system',
      metadata: { decisionId: decision.id },
    });
    this.archiveDiscussionSessions(discussion.id);
    return { discussionId: discussion.id, status: 'COMPLETED', decisionId: decision.id };
  }

  private archiveDiscussionSessions(discussionId: string): void {
    if (!this.archiveSessionsOnClose) return;
    const discussion = this.storage.getDiscussion(discussionId);
    const collaborationSession = discussion?.collaborationSessionId
      ? this.storage.getCollaborationSession(discussion.collaborationSessionId)
      : null;
    if (collaborationSession && collaborationSession.policy !== 'fresh') {
      this.audit.log({
        traceId: discussion?.traceId ?? `tr_${discussionId}`,
        discussionId,
        action: 'session.archive_shared_skipped',
        agent: 'system',
        metadata: { collaborationSessionId: collaborationSession.id, policy: collaborationSession.policy },
      });
      return;
    }
    for (const session of this.storage.listSessionsForDiscussion(discussionId)) {
      const connector = this.connectors[session.provider];
      const kind = readProviderSessionKind(session.metadata.sessionKind);
      void Promise.resolve(connector?.archiveSession?.(session.sessionId, kind) ?? false)
        .then((archived) => {
          if (archived) this.storage.updateSessionStatus(session.provider, session.sessionId, 'ARCHIVED', session.metadata);
          this.audit.log({
            traceId: this.storage.getDiscussion(discussionId)?.traceId ?? `tr_${discussionId}`,
            discussionId,
            action: archived ? 'session.archived' : 'session.archive_unsupported',
            agent: session.provider,
            metadata: { sessionId: session.sessionId, sessionKind: kind ?? null },
          });
        })
        .catch((cause) => this.audit.log({
          traceId: this.storage.getDiscussion(discussionId)?.traceId ?? `tr_${discussionId}`,
          discussionId,
          action: 'session.archive_failed',
          agent: session.provider,
          metadata: { sessionId: session.sessionId, error: redactDiagnostic(cause instanceof Error ? cause.message : String(cause)) },
        }));
    }
  }
}

function buildAgreementPrompt(conclusion: string, decisionHash: string): string {
  return [
    'AgentBridge agreement confirmation request.',
    'Review the canonical conclusion below against the discussion context.',
    'Do not call AgentBridge tools. Return exactly one JSON object and no markdown.',
    `Use {"agentbridgeDecision":"accept","decisionHash":"${decisionHash}"} only if you accept it unchanged.`,
    `Otherwise use {"agentbridgeDecision":"reject","decisionHash":"${decisionHash}","resolution":"continue","reason":"brief reason"} or set resolution to "user_decision".`,
    'Use resolution="continue" only when new evidence or a concrete revision can still resolve the objection.',
    'Use resolution="user_decision" when the disagreement depends on incompatible goals, risk tolerance, permissions, or product preferences.',
    'Canonical conclusion:',
    conclusion,
  ].join('\n\n');
}

function parseAgreementResponse(
  content: string,
  expectedHash: string,
): { accepted: boolean; reason?: string; resolution?: AgreementResolution } {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { accepted: false, reason: 'missing_json_confirmation', resolution: 'user_decision' };
  }
  try {
    const value = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (value.decisionHash !== expectedHash) {
      return { accepted: false, reason: 'decision_hash_mismatch', resolution: 'user_decision' };
    }
    if (value.agentbridgeDecision === 'accept') return { accepted: true };
    const resolution = value.resolution === 'continue' || value.resolution === 'user_decision'
      ? value.resolution
      : 'user_decision';
    return {
      accepted: false,
      reason: typeof value.reason === 'string' ? value.reason : 'peer_rejected',
      resolution,
    };
  } catch {
    return { accepted: false, reason: 'invalid_json_confirmation', resolution: 'user_decision' };
  }
}

function readProviderSessionKind(value: unknown): ProviderSessionKind | undefined {
  return value === 'claude-cli' || value === 'codex-cli' || value === 'codex-app-server'
    ? value
    : undefined;
}

function assertParticipants(driver: AgentType, peer: AgentType): void {
  if (driver === peer) throw new Error('Discussion driver and peer must be different agents');
}

function discussionModeRank(mode: DiscussionMode): number {
  return mode === 'review' ? 0 : mode === 'discussion' ? 1 : 2;
}

function oppositeAgent(agent: AgentType): AgentType {
  return agent === 'claude' ? 'codex' : 'claude';
}

function stripDiscussionSignal(content: string): string {
  return content
    .replace(/\s*\[AGENTBRIDGE_SIGNAL:\s*(?:CONTINUE|READY_TO_CLOSE|NEEDS_USER_DECISION)\]\s*$/, '')
    .trim();
}

function isAutomaticDiscussion(discussion: Discussion): boolean {
  return discussion.orchestration === 'automatic';
}

function isLegacyRetryablePeerMessage(
  message: Message,
  discussion: Pick<Discussion, 'driver' | 'peer'>,
): boolean {
  const expectedReceiver = message.sender === discussion.driver ? discussion.peer : discussion.driver;
  return (message.role === 'proposal' || message.role === 'response')
    && message.sender !== message.receiver
    && message.receiver === expectedReceiver;
}

function assertText(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new ProviderError('TIMEOUT', `Peer connector timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyFailure(cause: unknown): 'FAILED' | 'PEER_BUSY' | 'TIMEOUT' | 'CANCELLED' | 'NEEDS_USER_DECISION' {
  if (cause instanceof SessionBusyError) return 'PEER_BUSY';
  if (isProviderErrorLike(cause)) {
    if (cause.ambiguous) return 'NEEDS_USER_DECISION';
    if (cause.code === 'BUSY' || cause.code === 'UNAVAILABLE') return 'PEER_BUSY';
    if (cause.code === 'TIMEOUT') return 'TIMEOUT';
    if (cause.code === 'CANCELLED') return 'CANCELLED';
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (message.includes('busy') || message.includes('not available')) return 'PEER_BUSY';
  if (message.includes('timed out') || message.includes('timeout') || message.includes('duration')) return 'TIMEOUT';
  return 'FAILED';
}

function diagnosticFromError(cause: unknown, receiver: AgentType, backend: unknown) {
  const message = redactDiagnostic(cause instanceof Error ? cause.message : String(cause));
  return {
    code: isProviderErrorLike(cause) ? cause.code : 'FAILED',
    message,
    backend: isProviderErrorLike(cause) && cause.backend
      ? cause.backend
      : typeof backend === 'string' ? backend : receiver,
    retryable: isProviderErrorLike(cause) ? cause.retryable : true,
    ambiguous: isProviderErrorLike(cause) ? cause.ambiguous : false,
    at: new Date().toISOString(),
  };
}

function isProviderErrorLike(value: unknown): value is ProviderError {
  if (isProviderError(value)) return true;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown; ambiguous?: unknown };
  return candidate.name === 'ProviderError'
    && typeof candidate.code === 'string'
    && typeof candidate.ambiguous === 'boolean';
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(token|password|api[_ -]?key)\s*[:=]\s*[^\s;]+/gi, '$1=[REDACTED]')
    .slice(0, 4_096);
}

function isOwnerProcessAlive(ownerId: string): boolean {
  const match = /^collaboration:(\d+):/.exec(ownerId);
  if (!match) return false;
  try {
    process.kill(Number(match[1]), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCompletion(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
