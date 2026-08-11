import type { StoragePort } from '@agentbridge/storage';
import { AuditService } from '@agentbridge/audit';
import type { AgentConnector, ProviderSessionKind } from '@agentbridge/connectors';
import type {
  AgentType,
  Message,
  AskPeerOutput,
  ReplyPeerOutput,
  GetDiscussionOutput,
  CloseDiscussionOutput,
  CancelDiscussionOutput,
  RetryDiscussionOutput,
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

export interface CollaborationConfig {
  maxTurns?: number;
  timeoutMs?: number;
  maxDurationMs?: number;
  maxTotalMessageChars?: number;
  asyncDispatch?: boolean;
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
  private readonly timeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly maxTotalMessageChars: number;
  private readonly asyncDispatch: boolean;
  private readonly connectors: ConnectorRegistry;
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    storage: StoragePort,
    audit: AuditService,
    config: CollaborationConfig = {},
    connectors: ConnectorRegistry = {},
  ) {
    this.storage = storage;
    this.audit = audit;
    this.maxTurns = config.maxTurns ?? 6;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxDurationMs = config.maxDurationMs ?? 30 * 60 * 1_000;
    this.maxTotalMessageChars = config.maxTotalMessageChars ?? 500_000;
    this.asyncDispatch = config.asyncDispatch ?? false;
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
  }): Promise<AskPeerOutput> {
    const projectPath = resolveProjectPath(params.projectPath);
    const maxTurns = params.maxTurns ?? this.maxTurns;
    assertParticipants(params.driver, params.peer);
    assertText(params.initialMessage, 'message');
    if (params.initialMessage.length > this.maxTotalMessageChars) {
      throw new Error('Discussion message budget exceeded');
    }

    const discussion = this.storage.createDiscussion({
      topic: params.topic,
      driver: params.driver,
      peer: params.peer,
      projectPath,
      traceId: params.traceId,
      maxTurns,
    });

    this.audit.log({
      traceId: params.traceId,
      discussionId: discussion.id,
      action: 'discussion.created',
      agent: params.driver,
      metadata: { peer: params.peer, topic: params.topic, projectPath },
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

    if (this.asyncDispatch) {
      this.startBackgroundDispatch(discussion.id, params.peer, params.initialMessage, []);
      return {
        discussionId: discussion.id,
        peer: params.peer,
        messageId: message.id,
        status: 'DISCUSSING',
      };
    }
    const peerResponse = await this.dispatchToAgent(discussion.id, params.peer, params.initialMessage, []);
    return {
      discussionId: discussion.id,
      peer: params.peer,
      messageId: message.id,
      status: 'DISCUSSING',
      ...(peerResponse ? { peerResponse } : {}),
    };
  }

  async replyToDiscussion(params: {
    discussionId: string;
    reply: string;
    sender: AgentType;
  }): Promise<ReplyPeerOutput> {
    assertText(params.reply, 'message');
    const discussion = this.storage.getDiscussion(params.discussionId);
    if (!discussion) throw new Error(`Discussion ${params.discussionId} not found`);
    if (isTerminal(discussion.status) || isPaused(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    if (![discussion.driver, discussion.peer].includes(params.sender)) {
      throw new Error(`Agent ${params.sender} is not a participant in discussion ${params.discussionId}`);
    }
    this.ensureNoDispatchInFlight(params.discussionId);
    this.ensureWithinBudget(discussion, params.reply);
    const overRoundBudget = discussion.roundCount >= discussion.maxTurns;

    const receiver = params.sender === discussion.driver ? discussion.peer : discussion.driver;
    this.ensureProviderNotLeased(receiver, discussion.projectPath);
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

    if (overRoundBudget) {
      this.storage.updateDiscussionStatus(params.discussionId, 'TIMEOUT');
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'discussion.timeout',
        agent: params.sender,
        metadata: { roundCount: discussion.roundCount, maxTurns: discussion.maxTurns, messageId: message.id },
      });
      return { messageId: message.id, status: 'TIMEOUT' };
    }

    this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
    const previousMessages = this.storage.getMessages(params.discussionId).slice(0, -1);
    if (this.asyncDispatch) {
      this.startBackgroundDispatch(params.discussionId, receiver, params.reply, previousMessages);
      return { messageId: message.id, status: 'DISCUSSING' };
    }
    const peerResponse = await this.dispatchToAgent(params.discussionId, receiver, params.reply, previousMessages);
    return {
      messageId: message.id,
      status: 'DISCUSSING',
      ...(peerResponse ? { peerResponse } : {}),
    };
  }

  async getDiscussion(discussionId: string): Promise<GetDiscussionOutput> {
    const discussion = this.storage.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion ${discussionId} not found`);

    return {
      discussion,
      messages: this.storage.getMessages(discussionId),
      decision: this.storage.getDecisionByDiscussion(discussionId),
    };
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
    let peerResponse: Message | undefined;
    try {
      peerResponse = await this.dispatchToAgent(
        params.discussionId,
        otherAgent,
        agreementPrompt,
        messages,
        { updateFailureStatus: false, countRound: false },
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
      };
    }

    const peerDecision = parseAgreementResponse(peerResponse.content, agreement.decisionHash);
    if (!peerDecision.accepted) {
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
      this.storage.releaseSessionLease(discussion.driver, discussion.projectPath, discussion.id);
      this.storage.releaseSessionLease(discussion.peer, discussion.projectPath, discussion.id);
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
      return { discussionId: discussion.id, status: 'CANCELLED' };
    } finally {
      this.cancellationRequests.delete(params.discussionId);
    }
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
    if (discussion.roundCount >= discussion.maxTurns) {
      throw new Error(`Discussion ${params.discussionId} exhausted its maxTurns budget`);
    }

    const messages = this.storage.getMessages(params.discussionId);
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      throw new Error(`Discussion ${params.discussionId} has no message to retry`);
    }
    this.ensureProviderNotLeased(lastMessage.receiver, discussion.projectPath);

    if (discussion.status === 'FAILED') {
      this.storage.updateDiscussionStatus(params.discussionId, 'CREATED');
    }
    this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.retry_requested',
      agent: params.agent,
      metadata: { retryCount: discussion.retryCount, maxRetries: discussion.maxRetries },
    });
    const previousMessages = messages.slice(0, -1);
    if (this.asyncDispatch) {
      this.startBackgroundDispatch(params.discussionId, lastMessage.receiver, lastMessage.content, previousMessages);
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        retryCount: discussion.retryCount,
      };
    }
    const peerResponse = await this.dispatchToAgent(
      params.discussionId,
      lastMessage.receiver,
      lastMessage.content,
      previousMessages,
    );
    return {
      discussionId: discussion.id,
      status: 'DISCUSSING',
      retryCount: discussion.retryCount,
      ...(peerResponse ? { peerResponse } : {}),
    };
  }

  private async dispatchToAgent(
    discussionId: string,
    receiver: AgentType,
    prompt: string,
    previousMessages: Message[],
    options: { updateFailureStatus?: boolean; countRound?: boolean } = {},
  ): Promise<Message | undefined> {
    const connector = this.connectors[receiver];
    if (!connector) return undefined;
    const discussion = this.storage.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion ${discussionId} not found`);
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
    let trackedSession: { sessionId: string; metadata: Record<string, unknown> } | undefined;
    this.inFlight.set(discussionId, operation);
    try {
      this.storage.acquireSessionLease({
        provider: receiver,
        projectPath: discussion.projectPath,
        ownerId: discussionId,
        ttlMs: this.timeoutMs,
      });
      leaseAcquired = true;
      if (!(await connector.isAvailable())) {
        throw new ProviderError('UNAVAILABLE', `${receiver} connector is not available`);
      }
      if (await connector.isBusy()) {
        throw new ProviderError('BUSY', `${receiver} session is busy`);
      }

      const persistedSession = this.storage.getSessionForDiscussion(
        receiver,
        discussionId,
        discussion.projectPath,
      );
      if (persistedSession) {
        trackedSession = { sessionId: persistedSession.sessionId, metadata: persistedSession.metadata };
        this.storage.updateSessionStatus(receiver, persistedSession.sessionId, 'BRIDGE_OWNED', {
          ...persistedSession.metadata,
          discussionId,
        });
      }
      const providerSessionKind = readProviderSessionKind(persistedSession?.metadata.sessionKind);
      const response = await withTimeout(
        connector.sendAndWait({
          projectPath: discussion.projectPath,
          prompt,
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
            availability: response.availability ?? 'BACKGROUND',
            sessionKind: response.providerSessionKind,
          },
        });
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
      const currentAfterResponse = this.storage.getDiscussion(discussionId);
      if (currentAfterResponse?.status === 'PEER_BUSY') {
        this.storage.updateDiscussionStatus(discussionId, 'DISCUSSING');
      }
      this.audit.log({
        traceId: discussion.traceId,
        discussionId,
        action: 'peer.response',
        agent: receiver,
        metadata: { messageId: message.id, duration: response.duration },
      });
      return message;
    } catch (cause) {
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
      if (leaseAcquired) this.storage.releaseSessionLease(receiver, discussion.projectPath, discussionId);
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
    options: { updateFailureStatus?: boolean; countRound?: boolean } = {},
  ): void {
    void this.dispatchToAgent(discussionId, receiver, prompt, previousMessages, options).catch(() => {
      // dispatchToAgent persists and audits the failure; the caller already
      // received an accepted asynchronous request.
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
    this.storage.releaseSessionLease('claude', this.storage.getDiscussion(discussion.id)!.projectPath, discussion.id);
    this.storage.releaseSessionLease('codex', this.storage.getDiscussion(discussion.id)!.projectPath, discussion.id);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.closed',
      agent: 'system',
      metadata: { decisionId: decision.id },
    });
    return { discussionId: discussion.id, status: 'COMPLETED', decisionId: decision.id };
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

function classifyFailure(cause: unknown): 'FAILED' | 'PEER_BUSY' | 'TIMEOUT' | 'CANCELLED' {
  if (cause instanceof SessionBusyError) return 'PEER_BUSY';
  if (isProviderError(cause)) {
    if (cause.code === 'BUSY' || cause.code === 'UNAVAILABLE') return 'PEER_BUSY';
    if (cause.code === 'TIMEOUT') return 'TIMEOUT';
    if (cause.code === 'CANCELLED') return 'CANCELLED';
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (message.includes('busy') || message.includes('not available')) return 'PEER_BUSY';
  if (message.includes('timed out') || message.includes('timeout') || message.includes('duration')) return 'TIMEOUT';
  return 'FAILED';
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
