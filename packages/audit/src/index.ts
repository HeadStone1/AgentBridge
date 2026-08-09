import type { AuditEvent, AgentType } from '@agentbridge/protocol';
import type { StoragePort } from '@agentbridge/storage';

export interface AuditMetrics {
  generatedAt: string;
  totalEvents: number;
  peerCallSuccess: number;
  peerCallFailure: number;
  sessionBusy: number;
  discussionRounds: number;
  averagePeerCallLatencyMs: number;
}

export class AuditService {
  private storage: StoragePort;

  constructor(storage: StoragePort) {
    this.storage = storage;
  }

  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    return this.storage.appendAudit(event);
  }

  getLog(discussionId?: string, limit = 100): AuditEvent[] {
    return this.storage.getAuditLog(discussionId, limit);
  }

  getMetrics(discussionId?: string): AuditMetrics {
    const events = this.storage.getAuditLog(discussionId, 10_000);
    const latencyValues = events
      .filter((event) => event.action === 'peer.response' && typeof event.metadata.duration === 'number')
      .map((event) => event.metadata.duration as number);
    return {
      generatedAt: new Date().toISOString(),
      totalEvents: events.length,
      peerCallSuccess: events.filter((event) => event.action === 'peer.response').length,
      peerCallFailure: events.filter((event) => event.action === 'error').length,
      sessionBusy: events.filter((event) => event.action === 'session.busy').length,
      discussionRounds: events.filter((event) => event.action === 'message.sent').length,
      averagePeerCallLatencyMs: latencyValues.length === 0
        ? 0
        : Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length),
    };
  }

  logDiscussionCreated(params: {
    traceId: string;
    discussionId: string;
    driver: AgentType;
    peer: AgentType;
    topic: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'discussion.created',
      agent: params.driver,
      metadata: { peer: params.peer, topic: params.topic },
    });
  }

  logMessageSent(params: {
    traceId: string;
    discussionId: string;
    agent: AgentType;
    messageId: string;
    role: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'message.sent',
      agent: params.agent,
      metadata: { messageId: params.messageId, role: params.role },
    });
  }

  logPeerResponse(params: {
    traceId: string;
    discussionId: string;
    agent: AgentType;
    messageId: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'peer.response',
      agent: params.agent,
      metadata: { messageId: params.messageId },
    });
  }

  logDecisionCreated(params: {
    traceId: string;
    discussionId: string;
    decisionId: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'decision.created',
      agent: 'system',
      metadata: { decisionId: params.decisionId },
    });
  }

  logAgreement(params: {
    traceId: string;
    discussionId: string;
    agent: AgentType;
    decisionHash: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: `agreement.${params.agent}`,
      agent: params.agent,
      metadata: { decisionHash: params.decisionHash },
    });
  }

  logDiscussionClosed(params: {
    traceId: string;
    discussionId: string;
    status: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'discussion.closed',
      agent: 'system',
      metadata: { status: params.status },
    });
  }

  logError(params: {
    traceId: string;
    discussionId: string;
    agent: AgentType | 'system';
    error: string;
  }) {
    this.log({
      traceId: params.traceId,
      discussionId: params.discussionId,
      action: 'error',
      agent: params.agent,
      metadata: { error: params.error },
    });
  }
}
