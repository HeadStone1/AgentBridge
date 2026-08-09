import { beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../packages/storage/src/index';
import { AuditService } from '../../packages/audit/src/index';
import { CollaborationService } from '../../packages/collaboration/src/index';
import { ClaudeConnector } from '../../packages/connectors/src/claude';
import { CodexConnector } from '../../packages/connectors/src/codex';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claudeFixture = resolve(fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url)));
const codexFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url)));

describe('CollaborationService', () => {
  let storage: Storage;
  let collaboration: CollaborationService;

  beforeEach(() => {
    storage = new Storage(':memory:');
    collaboration = new CollaborationService(storage, new AuditService(storage));
  });

  it('requires both agents to accept the same conclusion', async () => {
    const started = await collaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'review',
      initialMessage: 'Please review this plan',
      traceId: 'tr_test',
    });

    const first = await collaboration.closeDiscussion({
      discussionId: started.discussionId,
      conclusion: 'Use the safer plan',
      agent: 'claude',
    });
    expect(first.status).toBe('DISCUSSING');
    expect(first.waitingFor).toEqual(['codex']);

    const second = await collaboration.closeDiscussion({
      discussionId: started.discussionId,
      conclusion: 'Use the safer plan',
      agent: 'codex',
    });
    expect(second.status).toBe('COMPLETED');
    expect(second.decisionId).toMatch(/^dec_/);

    const result = await collaboration.getDiscussion(started.discussionId);
    expect(result.discussion.status).toBe('COMPLETED');
    expect(result.decision?.agreedBy).toEqual(['claude', 'codex']);
  });

  it('automatically asks the peer to confirm and completes a matching conclusion', async () => {
    const agreementStorage = new Storage(':memory:');
    const agreementCollaboration = new CollaborationService(
      agreementStorage,
      new AuditService(agreementStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async (context) => {
            const hash = context.prompt.match(/"decisionHash":"([a-f0-9]+)"/)?.[1];
            return {
              content: JSON.stringify({ agentbridgeDecision: 'accept', decisionHash: hash }),
              duration: 1,
              providerSessionId: 'codex-agreement-session',
              providerSessionKind: 'codex-cli',
            };
          },
        },
      },
    );
    const started = await agreementCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'automatic agreement',
      initialMessage: 'Review the conclusion',
      traceId: 'tr_auto_agreement',
    });

    const closed = await agreementCollaboration.closeDiscussion({
      discussionId: started.discussionId,
      conclusion: 'Ship the reviewed implementation',
      agent: 'claude',
    });

    expect(closed.status).toBe('COMPLETED');
    expect(closed.peerAccepted).toBe(true);
    expect((await agreementCollaboration.getDiscussion(started.discussionId)).decision?.agreedBy)
      .toEqual(['claude', 'codex']);
    agreementStorage.close();
  });

  it('rejects a changed conclusion after the first acceptance', async () => {
    const started = await collaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'review',
      initialMessage: 'Please review this plan',
      traceId: 'tr_test_2',
    });

    await collaboration.closeDiscussion({
      discussionId: started.discussionId,
      conclusion: 'Plan A',
      agent: 'claude',
    });

    await expect(collaboration.closeDiscussion({
      discussionId: started.discussionId,
      conclusion: 'Plan B',
      agent: 'codex',
    })).rejects.toThrow('same decision hash');
  });

  it('rejects non-participants', async () => {
    const started = await collaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'review',
      initialMessage: 'Please review this plan',
      traceId: 'tr_test_3',
    });

    await expect(collaboration.replyToDiscussion({
      discussionId: started.discussionId,
      reply: 'spoofed reply',
      sender: 'other' as 'claude',
    })).rejects.toThrow('not a participant');
  });

  it('dispatches a three-round local connector chain with correct message directions', async () => {
    const connectedStorage = new Storage(':memory:');
    const connectedCollaboration = new CollaborationService(
      connectedStorage,
      new AuditService(connectedStorage),
      { timeoutMs: 5_000 },
      {
        claude: new ClaudeConnector({ command: process.execPath, extraArgs: [claudeFixture], timeoutMs: 5_000 }),
        codex: new CodexConnector({ command: process.execPath, extraArgs: [codexFixture], timeoutMs: 5_000 }),
      },
    );

    const started = await connectedCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'three rounds',
      initialMessage: 'round one',
      traceId: 'tr_chain',
    });
    await connectedCollaboration.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'codex',
      reply: 'round two',
    });
    await connectedCollaboration.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'round three',
    });

    const result = await connectedCollaboration.getDiscussion(started.discussionId);
    expect(result.messages.map((message) => `${message.sender}->${message.receiver}`)).toEqual([
      'claude->codex',
      'codex->claude',
      'codex->claude',
      'claude->codex',
      'claude->codex',
      'codex->claude',
    ]);
    expect(result.messages.at(-1)?.content).toBe('resumed codex response');
    expect(connectedStorage.listSessions().map((session) => session.provider).sort()).toEqual(['claude', 'codex']);
    connectedStorage.close();
  });

  it('marks an unavailable peer as PEER_BUSY and releases the lease', async () => {
    const peerStorage = new Storage(':memory:');
    const peerCollaboration = new CollaborationService(
      peerStorage,
      new AuditService(peerStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => false,
          isBusy: async () => false,
          sendAndWait: async () => { throw new Error('not called'); },
        },
      },
    );

    await expect(peerCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'unavailable',
      initialMessage: 'probe',
      traceId: 'tr_unavailable',
    })).rejects.toThrow('not available');
    expect(peerStorage.listDiscussions()[0].status).toBe('PEER_BUSY');
    expect(() => peerStorage.acquireSessionLease({
      provider: 'codex',
      projectPath: process.cwd(),
      ownerId: 'after-failure',
    })).not.toThrow();
    peerStorage.close();
  });

  it('cancels an active discussion and returns the project lease', async () => {
    const cancelStorage = new Storage(':memory:');
    const cancelCollaboration = new CollaborationService(cancelStorage, new AuditService(cancelStorage));
    const started = await cancelCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'cancel',
      initialMessage: 'stop this discussion',
      traceId: 'tr_cancel',
    });

    const cancelled = await cancelCollaboration.cancelDiscussion({
      discussionId: started.discussionId,
      agent: 'claude',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect((await cancelCollaboration.getDiscussion(started.discussionId)).discussion.status).toBe('CANCELLED');
    cancelStorage.close();
  });

  it('stops a discussion when its total message budget is exceeded', async () => {
    const budgetStorage = new Storage(':memory:');
    const budgetCollaboration = new CollaborationService(
      budgetStorage,
      new AuditService(budgetStorage),
      { maxTotalMessageChars: 1_000 },
    );
    const started = await budgetCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'budget',
      initialMessage: 'a'.repeat(600),
      traceId: 'tr_budget',
    });

    await expect(budgetCollaboration.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'b'.repeat(600),
    })).rejects.toThrow('message budget');
    expect((await budgetCollaboration.getDiscussion(started.discussionId)).discussion.status).toBe('TIMEOUT');
    budgetStorage.close();
  });

  it('requires an explicit retry after a connector failure', async () => {
    const retryStorage = new Storage(':memory:');
    let attempts = 0;
    const retryCollaboration = new CollaborationService(
      retryStorage,
      new AuditService(retryStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async (context) => {
            attempts += 1;
            if (attempts === 1) throw new Error('simulated connector failure');
            return {
              content: 'retry succeeded',
              duration: 1,
            };
          },
        },
      },
    );

    let discussionId = '';
    await expect(retryCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'retry',
      initialMessage: 'retry me',
      traceId: 'tr_retry',
    })).rejects.toThrow('simulated connector failure');
    discussionId = retryStorage.listDiscussions()[0].id;
    expect(retryStorage.getDiscussion(discussionId)?.status).toBe('FAILED');
    expect(retryStorage.getDiscussion(discussionId)?.retryCount).toBe(1);

    const retried = await retryCollaboration.retryDiscussion({ discussionId, agent: 'claude' });
    expect(retried.status).toBe('DISCUSSING');
    expect(retried.retryCount).toBe(1);
    expect(retried.peerResponse?.content).toBe('retry succeeded');
    expect(attempts).toBe(2);
    expect(retryStorage.getMessages(discussionId)).toHaveLength(2);
    retryStorage.close();
  });

  it('restores a provider session from SQLite after the collaboration process restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-session-restart-'));
    const dbPath = join(directory, 'agentbridge.sqlite');
    try {
      const firstStorage = new Storage(dbPath);
      const firstCollaboration = new CollaborationService(
        firstStorage,
        new AuditService(firstStorage),
        { timeoutMs: 5_000 },
        { codex: new CodexConnector({ command: process.execPath, extraArgs: [codexFixture], timeoutMs: 5_000 }) },
      );
      const started = await firstCollaboration.initiateDiscussion({
        driver: 'claude',
        peer: 'codex',
        topic: 'restart recovery',
        initialMessage: 'first round',
        projectPath: directory,
        traceId: 'tr_restart',
      });
      firstStorage.close();

      const secondStorage = new Storage(dbPath);
      const secondCollaboration = new CollaborationService(
        secondStorage,
        new AuditService(secondStorage),
        { timeoutMs: 5_000 },
        { codex: new CodexConnector({ command: process.execPath, extraArgs: [codexFixture], timeoutMs: 5_000 }) },
      );
      const continued = await secondCollaboration.replyToDiscussion({
        discussionId: started.discussionId,
        sender: 'claude',
        reply: 'second round',
      });
      expect(continued.peerResponse?.content).toBe('resumed codex response');
      expect(secondStorage.getSessionForDiscussion('codex', started.discussionId, directory)?.sessionId)
        .toBe('thread_fake_codex');
      secondStorage.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
