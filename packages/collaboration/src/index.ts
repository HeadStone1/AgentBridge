import { randomUUID } from 'node:crypto';
import type { StoragePort } from '@agentbridge/storage';
import { AuditService } from '@agentbridge/audit';
import type { AgentConnector, ProviderSessionKind } from '@agentbridge/connectors';
import type {
  AgentType,
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
  defaultMaxTurnsForMode,
  discussionPhase,
  parseDiscussionSignal,
  resolveDiscussionMode,
} from './discussionPolicy.js';

export {
  assertDiscussionMode,
  buildDiscussionPrompt,
  defaultMaxTurnsForMode,
  discussionPhase,
  parseDiscussionSignal,
  resolveDiscussionMode,
} from './discussionPolicy.js';

export interface CollaborationConfig {
  maxTurns?: number;
  timeoutMs?: number;
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
  private readonly maxDurationMs: number;
  private readonly maxTotalMessageChars: number;
  private readonly asyncDispatch: boolean;
  private readonly archiveSessionsOnClose: boolean;
  private readonly sessionPolicy: SessionPolicy;
  private readonly connectors: ConnectorRegistry;
  private readonly ownerId = `collaboration:${process.pid}:${randomUUID()}`;
  private readonly inFlight = new Map<string, InFlightOperation>();
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
    this.timeoutMs = config.timeoutMs ?? 120_000;
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
    if (!Number.isInteger(this.maxDurationMs) || this.maxDurationMs < 1_000 || this.maxDurationMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('maxDurationMs must be an integer between 1000 and 604800000');
    }
    if (!Number.isInteger(this.maxTotalMessageChars) || this.maxTotalMessageChars < 1_000 || this.maxTotalMessageChars > 10_000_000) {
      throw new Error('maxTotalMessageChars must be an integer between 1000 and 10000000');
    }
    this.connectors = connectors;
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
        messageId: message.id,
        status: 'DISCUSSING',
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
      messageId: message.id,
      status: current?.status ?? 'DISCUSSING',
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

    const receiver = params.sender === discussion.driver ? discussion.peer : discussion.driver;
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
        this.storage.updateDiscussionMode(params.discussionId, requestedMode);
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
      this.queueDispatch(params.discussionId, receiver);
      const previousMessages = this.storage.getMessages(params.discussionId).slice(0, -1);
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
        return { messageId: message.id, status: 'DISCUSSING', dispatchState: 'QUEUED' };
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
      providerSessions: this.storage.listSessionsForDiscussion(discussionId).map((session) => ({
        provider: session.provider,
        sessionId: session.sessionId,
        kind: typeof session.metadata.sessionKind === 'string' ? session.metadata.sessionKind : null,
        status: session.status,
        lastSeenAt: session.lastSeenAt,
      })),
    };
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
        || (snapshot.discussion.dispatchState !== 'QUEUED' && snapshot.discussion.dispatchState !== 'RUNNING');
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
      this.storage.updateDiscussionDispatch(params.discussionId, 'COMPLETED', params.agent);
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'agreement.rejected',
        agent: otherAgent,
        metadata: { reason: peerDecision.reason ?? 'invalid_or_rejected_response' },
      });
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        waitingFor: [params.agent],
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
      if (!failedMessageId || !failedReceiver || discussion.failedOperationKind !== 'peer_message') {
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
    let resolveDone!: () => void;
    const operation: InFlightOperation = {
      controller,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      resolveDone: () => resolveDone(),
    };
    let leaseAcquired = false;
    let discussionLeaseAcquired = options.discussionLeaseOwned === true;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let trackedSession: { sessionId: string; metadata: Record<string, unknown> } | undefined;
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
      if (!connector) {
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
            controller.abort();
          }
          if (!this.storage.renewDiscussionLease(discussionId, this.ownerId, this.timeoutMs)) {
            controller.abort();
          }
        } catch {
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
      const response = await withTimeout(
        connector.sendAndWait({
          projectPath: discussion.projectPath,
          prompt: effectivePrompt,
          discussionId,
          previousMessages,
          providerSessionId: persistedSession?.sessionId,
          providerSessionKind,
          signal: controller.signal,
        }),
        this.timeoutMs,
        () => controller.abort(),
      );

      if (controller.signal.aborted) {
        throw new ProviderError('CANCELLED', `Peer ${receiver} request was cancelled`);
      }

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
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (leaseAcquired) this.storage.releaseSessionLease(receiver, discussion.projectPath, discussionId);
      if (discussionLeaseAcquired) this.storage.releaseDiscussionLease(discussionId, this.ownerId);
      operation.resolveDone();
      if (this.inFlight.get(discussionId) === operation) this.inFlight.delete(discussionId);
    }
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
    `Otherwise use {"agentbridgeDecision":"reject","decisionHash":"${decisionHash}","reason":"brief reason"}.`,
    'Canonical conclusion:',
    conclusion,
  ].join('\n\n');
}

function parseAgreementResponse(
  content: string,
  expectedHash: string,
): { accepted: boolean; reason?: string } {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return { accepted: false, reason: 'missing_json_confirmation' };
  try {
    const value = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (value.decisionHash !== expectedHash) return { accepted: false, reason: 'decision_hash_mismatch' };
    if (value.agentbridgeDecision === 'accept') return { accepted: true };
    return {
      accepted: false,
      reason: typeof value.reason === 'string' ? value.reason : 'peer_rejected',
    };
  } catch {
    return { accepted: false, reason: 'invalid_json_confirmation' };
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
  if (isProviderError(cause)) {
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
    code: isProviderError(cause) ? cause.code : 'FAILED',
    message,
    backend: isProviderError(cause) && cause.backend
      ? cause.backend
      : typeof backend === 'string' ? backend : receiver,
    retryable: isProviderError(cause) ? cause.retryable : true,
    ambiguous: isProviderError(cause) ? cause.ambiguous : false,
    at: new Date().toISOString(),
  };
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(token|password|api[_ -]?key)\s*[:=]\s*[^\s;]+/gi, '$1=[REDACTED]')
    .slice(0, 4_096);
}

async function waitForCompletion(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
