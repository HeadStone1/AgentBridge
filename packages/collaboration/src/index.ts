import type { StoragePort } from '@agentbridge/storage';
import { AuditService } from '@agentbridge/audit';
import type { AgentConnector } from '@agentbridge/connectors';
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
import { isTerminal } from '@agentbridge/protocol';

export interface CollaborationConfig {
  maxTurns?: number;
  timeoutMs?: number;
  maxDurationMs?: number;
  maxTotalMessageChars?: number;
}

export type ConnectorRegistry = Partial<Record<AgentType, AgentConnector>>;

export class CollaborationService {
  private readonly storage: StoragePort;
  private readonly audit: AuditService;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly maxTotalMessageChars: number;
  private readonly connectors: ConnectorRegistry;

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
    const projectPath = params.projectPath ?? process.cwd();
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

    const peerResponse = await this.dispatchToAgent(discussion.id, params.peer, params.initialMessage, [message]);
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
    if (isTerminal(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    this.ensureWithinBudget(discussion, params.reply);
    if (![discussion.driver, discussion.peer].includes(params.sender)) {
      throw new Error(`Agent ${params.sender} is not a participant in discussion ${params.discussionId}`);
    }
    if (discussion.currentTurn >= discussion.maxTurns) {
      this.storage.updateDiscussionStatus(params.discussionId, 'TIMEOUT');
      this.audit.log({
        traceId: discussion.traceId,
        discussionId: params.discussionId,
        action: 'discussion.timeout',
        agent: params.sender,
        metadata: { currentTurn: discussion.currentTurn, maxTurns: discussion.maxTurns },
      });
      return { messageId: '', status: 'TIMEOUT' };
    }

    const receiver = params.sender === discussion.driver ? discussion.peer : discussion.driver;
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

    this.storage.updateDiscussionStatus(params.discussionId, 'DISCUSSING');
    const peerResponse = await this.dispatchToAgent(params.discussionId, receiver, params.reply, [message]);
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
    if (isTerminal(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} is already ${discussion.status}`);
    }
    this.ensureWithinBudget(discussion);
    if (![discussion.driver, discussion.peer].includes(params.agent)) {
      throw new Error(`Agent ${params.agent} is not a participant in discussion ${params.discussionId}`);
    }

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

    const otherAgent = params.agent === discussion.driver ? discussion.peer : discussion.driver;
    if (agreement.agreedBy.length < 2) {
      return {
        discussionId: params.discussionId,
        status: 'DISCUSSING',
        waitingFor: [otherAgent],
      };
    }

    if (discussion.status !== 'AGREED') {
      this.storage.updateDiscussionStatus(params.discussionId, 'AGREED');
    }

    const decision = this.storage.getDecisionByDiscussion(params.discussionId) ?? this.storage.createDecision({
      discussionId: params.discussionId,
      summary: params.conclusion,
      changes: [],
      agreedBy: agreement.agreedBy,
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: params.discussionId,
      action: 'decision.created',
      agent: 'system',
      metadata: { decisionId: decision.id, decisionHash: decision.decisionHash },
    });

    this.storage.updateDiscussionStatus(params.discussionId, 'COMPLETED', {
      conclusion: params.conclusion,
      endedAt: new Date().toISOString(),
    });
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: params.discussionId,
      action: 'discussion.closed',
      agent: 'system',
      metadata: { decisionId: decision.id },
    });

    return { discussionId: params.discussionId, status: 'COMPLETED', decisionId: decision.id };
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

    const connectors = [this.connectors[discussion.driver], this.connectors[discussion.peer]];
    await Promise.all(connectors.map((connector) => connector?.cancel?.(params.discussionId)));
    this.storage.updateDiscussionStatus(params.discussionId, 'CANCELLED', {
      endedAt: new Date().toISOString(),
    });
    this.storage.releaseSessionLease(discussion.driver, discussion.projectPath, discussion.id);
    this.storage.releaseSessionLease(discussion.peer, discussion.projectPath, discussion.id);
    this.audit.log({
      traceId: discussion.traceId,
      discussionId: discussion.id,
      action: 'discussion.cancelled',
      agent: params.agent,
      metadata: {},
    });
    return { discussionId: discussion.id, status: 'CANCELLED' };
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
    if (!['FAILED', 'PEER_BUSY', 'TIMEOUT', 'NEEDS_USER_DECISION'].includes(discussion.status)) {
      throw new Error(`Discussion ${params.discussionId} cannot be retried from ${discussion.status}`);
    }

    const messages = this.storage.getMessages(params.discussionId);
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      throw new Error(`Discussion ${params.discussionId} has no message to retry`);
    }

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
    const peerResponse = await this.dispatchToAgent(
      params.discussionId,
      lastMessage.receiver,
      lastMessage.content,
      [lastMessage],
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
  ): Promise<Message | undefined> {
    const connector = this.connectors[receiver];
    if (!connector) return undefined;
    const discussion = this.storage.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion ${discussionId} not found`);
    this.storage.acquireSessionLease({
      provider: receiver,
      projectPath: discussion.projectPath,
      ownerId: discussionId,
      ttlMs: this.timeoutMs,
    });

    try {
      if (!(await connector.isAvailable())) {
        throw new Error(`${receiver} connector is not available`);
      }
      if (await connector.isBusy()) {
        throw new Error(`${receiver} session is busy`);
      }

      const response = await withTimeout(
        connector.sendAndWait({
          projectPath: discussion.projectPath,
          prompt,
          discussionId,
          previousMessages,
        }),
        this.timeoutMs,
      );

      this.ensureWithinBudget(discussion, response.message.content);

      if (response.availability) {
        this.audit.log({
          traceId: discussion.traceId,
          discussionId,
          action: 'peer.availability',
          agent: receiver,
          metadata: { availability: response.availability },
        });
      }

      const providerSessionId = response.providerSessionId ?? response.message.providerSessionId;
      if (providerSessionId) {
        this.storage.registerSession({
          provider: receiver,
          sessionId: providerSessionId,
          projectPath: discussion.projectPath,
          status: 'IDLE',
          metadata: {
            discussionId,
            availability: response.availability ?? 'BACKGROUND',
          },
        });
      }

      const message = this.storage.createMessage({
        discussionId,
        sender: receiver,
        receiver: receiver === discussion.driver ? discussion.peer : discussion.driver,
        role: 'response',
        content: response.message.content,
        projectPath: discussion.projectPath,
        providerSessionId,
      });
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
      if (current && !isTerminal(current.status)) {
        const nextStatus = classifyFailure(cause);
        if (nextStatus === 'PEER_BUSY') {
          this.audit.log({
            traceId: discussion.traceId,
            discussionId,
            action: 'session.busy',
            agent: receiver,
            metadata: { error: cause instanceof Error ? cause.message : String(cause) },
          });
        }
        if (nextStatus === 'FAILED') {
          this.storage.incrementRetry(discussionId);
        } else {
          this.storage.updateDiscussionStatus(discussionId, nextStatus);
        }
      }
      throw cause;
    } finally {
      this.storage.releaseSessionLease(receiver, discussion.projectPath, discussionId);
    }
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
}

function assertParticipants(driver: AgentType, peer: AgentType): void {
  if (driver === peer) throw new Error('Discussion driver and peer must be different agents');
}

function assertText(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Peer connector timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyFailure(cause: unknown): 'FAILED' | 'PEER_BUSY' | 'TIMEOUT' {
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (message.includes('busy') || message.includes('not available')) return 'PEER_BUSY';
  if (message.includes('timed out') || message.includes('timeout') || message.includes('duration')) return 'TIMEOUT';
  return 'FAILED';
}
