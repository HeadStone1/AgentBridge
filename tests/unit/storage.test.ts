import { describe, it, expect, beforeEach } from 'vitest';
import { Storage } from '../../packages/storage/src/index';

describe('Storage', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
  });

  describe('Discussions', () => {
    it('creates a discussion with generated id', () => {
      const d = storage.createDiscussion({
        topic: 'Test discussion',
        driver: 'claude',
        traceId: 'tr_test',
      });

      expect(d.id).toMatch(/^dsc_/);
      expect(d.status).toBe('CREATED');
      expect(d.driver).toBe('claude');
      expect(d.currentTurn).toBe(0);
      expect(d.roundCount).toBe(0);
      expect(d.maxTurns).toBe(6);
    });

    it('retrieves a discussion by id', () => {
      const created = storage.createDiscussion({
        topic: 'Retrieve test',
        driver: 'codex',
        traceId: 'tr_test2',
      });

      const retrieved = storage.getDiscussion(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.topic).toBe('Retrieve test');
    });

    it('allows one agent to revise a one-sided agreement before peer acceptance', () => {
      const discussion = storage.createDiscussion({
        topic: 'Agreement revision',
        driver: 'claude',
        peer: 'codex',
        traceId: 'tr_agreement_revision',
      });

      const first = storage.recordAgreement({
        discussionId: discussion.id,
        agent: 'claude',
        summary: 'Plan A',
      });
      const revised = storage.recordAgreement({
        discussionId: discussion.id,
        agent: 'claude',
        summary: 'Plan B',
      });

      expect(revised.decisionHash).not.toBe(first.decisionHash);
      expect(revised.agreedBy).toEqual(['claude']);
    });

    it('locks a discussion operation across storage connections', () => {
      const discussion = storage.createDiscussion({
        topic: 'Discussion lock',
        driver: 'claude',
        peer: 'codex',
        traceId: 'tr_discussion_lock',
      });
      storage.acquireDiscussionLease({
        discussionId: discussion.id,
        projectPath: discussion.projectPath,
        ownerId: 'owner-a',
      });
      expect(storage.hasDiscussionLease(discussion.id)).toBe(true);
      expect(() => storage.acquireDiscussionLease({
        discussionId: discussion.id,
        projectPath: discussion.projectPath,
        ownerId: 'owner-b',
      })).toThrow('already being operated on');
      expect(storage.renewDiscussionLease(discussion.id, 'owner-a', 5_000)).toBe(true);
      storage.releaseDiscussionLease(discussion.id, 'owner-a');
      expect(storage.hasDiscussionLease(discussion.id)).toBe(false);
    });

    it('updates discussion status', () => {
      const d = storage.createDiscussion({
        topic: 'Update test',
        driver: 'claude',
        traceId: 'tr_test3',
      });

      storage.updateDiscussionStatus(d.id, 'DISCUSSING');
      const updated = storage.getDiscussion(d.id);
      expect(updated!.status).toBe('DISCUSSING');
    });

    it('persists provider dispatch lifecycle independently from discussion status', () => {
      const d = storage.createDiscussion({
        topic: 'Dispatch state',
        driver: 'claude',
        peer: 'codex',
        traceId: 'tr_dispatch_state',
      });

      expect(d.dispatchState).toBeNull();
      expect(d.waitingFor).toBeNull();
      storage.updateDiscussionDispatch(d.id, 'QUEUED', 'codex');
      expect(storage.getDiscussion(d.id)).toMatchObject({
        dispatchState: 'QUEUED',
        waitingFor: 'codex',
      });
      storage.updateDiscussionDispatch(d.id, 'RUNNING', 'codex');
      storage.updateDiscussionDispatch(d.id, 'COMPLETED', null);
      expect(storage.getDiscussion(d.id)).toMatchObject({
        dispatchState: 'COMPLETED',
        waitingFor: null,
      });
    });

    it('lists discussions by project path', () => {
      storage.createDiscussion({ topic: 'A', driver: 'claude', traceId: 'tr1', projectPath: '/project' });
      storage.createDiscussion({ topic: 'B', driver: 'claude', traceId: 'tr2', projectPath: '/project' });
      storage.createDiscussion({ topic: 'C', driver: 'claude', traceId: 'tr3', projectPath: '/other' });

      const projectDiscussions = storage.listDiscussions('/project');
      expect(projectDiscussions).toHaveLength(2);
    });
  });

  describe('Messages', () => {
    it('creates a message and increments turn', () => {
      const d = storage.createDiscussion({
        topic: 'Message test',
        driver: 'claude',
        traceId: 'tr_msg',
      });

      const msg = storage.createMessage({
        discussionId: d.id,
        sender: 'claude',
        receiver: 'codex',
        role: 'proposal',
        content: 'Hello Codex, what do you think?',
      });

      expect(msg.id).toMatch(/^msg_/);
      expect(msg.sender).toBe('claude');
      expect(msg.receiver).toBe('codex');

      const updated = storage.getDiscussion(d.id);
      expect(updated!.currentTurn).toBe(1);
    });

    it('retrieves messages in order', () => {
      const d = storage.createDiscussion({
        topic: 'Order test',
        driver: 'claude',
        traceId: 'tr_order',
      });

      storage.createMessage({
        discussionId: d.id,
        sender: 'claude',
        receiver: 'codex',
        role: 'proposal',
        content: 'First message',
      });

      storage.createMessage({
        discussionId: d.id,
        sender: 'codex',
        receiver: 'claude',
        role: 'response',
        content: 'Second message',
      });

      const messages = storage.getMessages(d.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('First message');
      expect(messages[1].content).toBe('Second message');
    });

    it('retrieves messages after cursor', () => {
      const d = storage.createDiscussion({
        topic: 'Cursor test',
        driver: 'claude',
        traceId: 'tr_cursor',
      });

      const msg1 = storage.createMessage({
        discussionId: d.id,
        sender: 'claude',
        receiver: 'codex',
        role: 'proposal',
        content: 'First',
      });

      storage.createMessage({
        discussionId: d.id,
        sender: 'codex',
        receiver: 'claude',
        role: 'response',
        content: 'Second',
      });

      const after = storage.getMessages(d.id, msg1.id);
      expect(after).toHaveLength(1);
      expect(after[0].content).toBe('Second');
    });

    it('tracks provider rounds separately from message count', () => {
      const d = storage.createDiscussion({ topic: 'Round test', driver: 'claude', traceId: 'tr_round' });
      storage.createMessage({ discussionId: d.id, sender: 'claude', receiver: 'codex', role: 'proposal', content: 'proposal' });
      expect(storage.getDiscussion(d.id)?.currentTurn).toBe(1);
      expect(storage.incrementDiscussionRound(d.id).roundCount).toBe(1);
    });
  });

  describe('Decisions', () => {
    it('creates a decision with deterministic hash', () => {
      const d = storage.createDiscussion({
        topic: 'Decision test',
        driver: 'claude',
        traceId: 'tr_dec',
      });

      const decision = storage.createDecision({
        discussionId: d.id,
        summary: 'Use dark theme',
        changes: ['theme: dark', 'font: mono'],
        agreedBy: ['claude'],
      });

      expect(decision.id).toMatch(/^dec_/);
      expect(decision.decisionHash).toHaveLength(16);

      // Same input should produce same hash
      const decision2 = storage.createDecision({
        discussionId: d.id,
        summary: 'Use dark theme',
        changes: ['font: mono', 'theme: dark'], // different order
        agreedBy: ['claude'],
      });

      expect(decision2.decisionHash).toBe(decision.decisionHash);
    });

    it('retrieves decision by hash', () => {
      const d = storage.createDiscussion({
        topic: 'Hash lookup test',
        driver: 'claude',
        traceId: 'tr_hash',
      });

      const decision = storage.createDecision({
        discussionId: d.id,
        summary: 'Test hash',
        changes: ['a', 'b'],
        agreedBy: ['claude'],
      });

      const found = storage.getDecisionByHash(decision.decisionHash);
      expect(found).not.toBeNull();
      expect(found!.summary).toBe('Test hash');
    });
  });

  describe('Audit', () => {
    it('appends audit events', () => {
      const event = storage.appendAudit({
        traceId: 'tr_aud',
        discussionId: 'dsc_test',
        action: 'discussion.created',
        agent: 'claude',
        metadata: { topic: 'test' },
      });

      expect(event.id).toMatch(/^aud_/);
      expect(event.timestamp).toBeTruthy();
    });

    it('retrieves audit log by discussion', () => {
      storage.appendAudit({
        traceId: 'tr_aud2',
        discussionId: 'dsc_aud',
        action: 'message.sent',
        agent: 'claude',
        metadata: {},
      });

      const log = storage.getAuditLog('dsc_aud');
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe('message.sent');
    });

    it('limits audit log', () => {
      for (let i = 0; i < 10; i++) {
        storage.appendAudit({
          traceId: `tr_${i}`,
          discussionId: 'dsc_limit',
          action: 'message.sent',
          agent: 'claude',
          metadata: {},
        });
      }

      const log = storage.getAuditLog('dsc_limit', 5);
      expect(log).toHaveLength(5);
    });
  });

  describe('Session leases', () => {
    it('prevents concurrent leases for the same provider and project', () => {
      storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/project',
        ownerId: 'discussion-a',
      });
      expect(storage.hasSessionLease('codex', '/project', 'discussion-a')).toBe(true);

      expect(() => storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/project',
        ownerId: 'discussion-b',
      })).toThrow('already leased');

      storage.releaseSessionLease('codex', '/project', 'discussion-a');
      expect(storage.hasSessionLease('codex', '/project')).toBe(false);
      expect(() => storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/project',
        ownerId: 'discussion-b',
      })).not.toThrow();
    });

    it('renews an active lease without reviving an expired owner', () => {
      storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/project',
        ownerId: 'discussion-a',
        ttlMs: 1_000,
      });
      expect(storage.renewSessionLease('codex', '/project', 'discussion-a', 5_000)).toBe(true);
      expect(storage.hasSessionLease('codex', '/project', 'discussion-a')).toBe(true);
      expect(storage.renewSessionLease('codex', '/project', 'discussion-b', 5_000)).toBe(false);
    });
  });

  describe('Session registry', () => {
    it('registers, updates, lists, and removes provider sessions', () => {
      const session = storage.registerSession({
        provider: 'claude',
        sessionId: 'claude-session-1',
        projectPath: '/project',
        status: 'IDLE',
        metadata: { source: 'hook', discussionId: 'dsc_session', bridgeOwned: true },
      });

      expect(session.status).toBe('IDLE');
      expect(session.metadata).toEqual({ source: 'hook', discussionId: 'dsc_session', bridgeOwned: true });
      expect(storage.listSessions('/project')).toHaveLength(1);
      expect(storage.getSessionForDiscussion('claude', 'dsc_session', '/project')?.sessionId)
        .toBe('claude-session-1');

      const updated = storage.updateSessionStatus('claude', 'claude-session-1', 'BUSY');
      expect(updated.status).toBe('BUSY');
      expect(storage.getSession('claude', 'claude-session-1')?.status).toBe('BUSY');

      storage.unregisterSession('claude', 'claude-session-1');
      expect(storage.getSession('claude', 'claude-session-1')).toBeNull();
    });

    it('does not reuse an unbound project session across discussions', () => {
      storage.registerSession({
        provider: 'codex',
        sessionId: 'codex-project-session',
        projectPath: '/project',
        status: 'IDLE',
        metadata: { sessionKind: 'codex-cli', bridgeOwned: true },
      });
      expect(storage.getSessionForDiscussion('codex', 'dsc_other_discussion', '/project')).toBeNull();
    });

    it('reuses only a session explicitly bound to the current discussion', () => {
      storage.registerSession({
        provider: 'codex',
        sessionId: 'codex-discussion-session',
        projectPath: '/project',
        status: 'IDLE',
        metadata: { sessionKind: 'codex-cli', bridgeOwned: true, discussionId: 'dsc_current' },
      });
      expect(storage.getSessionForDiscussion('codex', 'dsc_current', '/project')?.sessionId)
        .toBe('codex-discussion-session');
      expect(storage.getSessionForDiscussion('codex', 'dsc_other', '/project')).toBeNull();
    });

    it('does not select an interactive or superseded session for a bridge dispatch', () => {
      storage.registerSession({
        provider: 'codex',
        sessionId: 'codex-interactive-session',
        projectPath: '/project',
        status: 'IDLE',
        metadata: { sessionKind: 'codex-cli', source: 'hook' },
      });
      expect(storage.getSessionForDiscussion('codex', 'dsc_other_discussion', '/project')).toBeNull();

      storage.registerSession({
        provider: 'codex',
        sessionId: 'codex-superseded-session',
        projectPath: '/project',
        status: 'IDLE',
        metadata: { bridgeOwned: true, supersededBy: 'codex-new-session' },
      });
      expect(storage.getSessionForDiscussion('codex', 'dsc_other_discussion', '/project')).toBeNull();
    });

    it('cleans expired session leases during recovery', () => {
      storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/expired',
        ownerId: 'old-owner',
        ttlMs: 1_000,
      });

      const recovered = storage.recoverExpiredSessionLeases(new Date(Date.now() + 2_000));
      expect(recovered).toBe(1);
      expect(() => storage.acquireSessionLease({
        provider: 'codex',
        projectPath: '/expired',
        ownerId: 'new-owner',
      })).not.toThrow();
    });
  });
});
