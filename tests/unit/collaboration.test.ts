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

  it('reuses provider sessions across discussions by default and creates fresh sessions on request', async () => {
    const calls: Array<{ provider: string; sessionId?: string; discussionId: string }> = [];
    const connectedStorage = new Storage(':memory:');
    const connectedCollaboration = new CollaborationService(
      connectedStorage,
      new AuditService(connectedStorage),
      { timeoutMs: 5_000 },
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async (context) => {
            calls.push({ provider: 'codex', sessionId: context.providerSessionId, discussionId: context.discussionId });
            return { content: 'response', duration: 1, providerSessionId: 'shared-codex', providerSessionKind: 'codex-cli' };
          },
        },
      },
    );
    const first = await connectedCollaboration.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'first', initialMessage: 'one', projectPath: '/project', traceId: 'tr_reuse_1',
    });
    const second = await connectedCollaboration.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'second', initialMessage: 'two', projectPath: '/project', traceId: 'tr_reuse_2',
    });
    const fresh = await connectedCollaboration.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'fresh', initialMessage: 'three', projectPath: '/project', traceId: 'tr_reuse_3', sessionPolicy: 'fresh',
    });

    expect(connectedStorage.getDiscussion(first.discussionId)?.collaborationSessionId)
      .toBe(connectedStorage.getDiscussion(second.discussionId)?.collaborationSessionId);
    expect(connectedStorage.getDiscussion(fresh.discussionId)?.collaborationSessionId)
      .not.toBe(connectedStorage.getDiscussion(first.discussionId)?.collaborationSessionId);
    expect(calls.map((call) => call.sessionId)).toEqual([undefined, 'shared-codex', undefined]);
    expect((await connectedCollaboration.getDiscussion(first.discussionId)).providerSessions.map((session) => session.sessionId))
      .toEqual(['shared-codex']);
    connectedStorage.close();
  });

  it('keeps fresh discussions isolated while reusing their own provider session across turns', async () => {
    const freshStorage = new Storage(':memory:');
    const calls: Array<{ discussionId: string; providerSessionId?: string }> = [];
    let created = 0;
    const service = new CollaborationService(
      freshStorage,
      new AuditService(freshStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async (context) => {
            calls.push({ discussionId: context.discussionId, providerSessionId: context.providerSessionId });
            const providerSessionId = context.providerSessionId ?? `fresh-codex-${++created}`;
            return { content: 'fresh response', duration: 1, providerSessionId, providerSessionKind: 'codex-cli' };
          },
        },
      },
    );

    const first = await service.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'fresh first', initialMessage: 'one',
      projectPath: '/fresh-project', traceId: 'tr_fresh_first', sessionPolicy: 'fresh',
    });
    await service.replyToDiscussion({
      discussionId: first.discussionId,
      sender: 'claude',
      reply: 'continue the isolated room',
    });
    const second = await service.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'fresh second', initialMessage: 'two',
      projectPath: '/fresh-project', traceId: 'tr_fresh_second', sessionPolicy: 'fresh',
    });

    expect(calls).toEqual([
      { discussionId: first.discussionId, providerSessionId: undefined },
      { discussionId: first.discussionId, providerSessionId: 'fresh-codex-1' },
      { discussionId: second.discussionId, providerSessionId: undefined },
    ]);
    expect(created).toBe(2);
    freshStorage.close();
  });

  it('does not archive a shared collaboration session when one discussion closes', async () => {
    const sharedStorage = new Storage(':memory:');
    const archived: string[] = [];
    const calls: Array<string | undefined> = [];
    const service = new CollaborationService(
      sharedStorage,
      new AuditService(sharedStorage),
      { archiveSessionsOnClose: true },
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async (context) => {
            calls.push(context.providerSessionId);
            return {
              content: 'shared response',
              duration: 1,
              providerSessionId: context.providerSessionId ?? 'shared-thread',
              providerSessionKind: 'codex-app-server',
            };
          },
          archiveSession: async (sessionId) => {
            archived.push(sessionId);
            return true;
          },
        },
      },
    );
    const first = await service.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'shared first', initialMessage: 'one',
      projectPath: '/shared-project', traceId: 'tr_shared_first',
    });
    const second = await service.initiateDiscussion({
      driver: 'claude', peer: 'codex', topic: 'shared second', initialMessage: 'two',
      projectPath: '/shared-project', traceId: 'tr_shared_second',
    });

    await service.cancelDiscussion({ discussionId: second.discussionId, agent: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.replyToDiscussion({
      discussionId: first.discussionId,
      sender: 'claude',
      reply: 'continue first discussion',
    });

    expect(archived).toEqual([]);
    expect(calls).toEqual([undefined, 'shared-thread', 'shared-thread']);
    expect(sharedStorage.getSession('codex', 'shared-thread')?.status).toBe('IDLE');
    expect(sharedStorage.getAuditLog(second.discussionId).some((event) => (
      event.action === 'session.archive_shared_skipped'
    ))).toBe(true);
    sharedStorage.close();
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

  it('rejects an unsent reply after the provider response limit', async () => {
    const roundStorage = new Storage(':memory:');
    const roundCollaboration = new CollaborationService(
      roundStorage,
      new AuditService(roundStorage),
      { maxTurns: 1 },
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async () => ({ content: 'first response', duration: 1 }),
        },
      },
    );
    const started = await roundCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'round limit',
      initialMessage: 'first',
      traceId: 'tr_round_limit',
    });

    await expect(roundCollaboration.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'must not be retained',
    })).rejects.toThrow('provider response limit');
    expect(roundStorage.getDiscussion(started.discussionId)).toMatchObject({
      status: 'NEEDS_USER_DECISION',
      stopReason: 'MAX_TURNS',
    });
    expect(roundStorage.getDiscussion(started.discussionId)?.roundCount).toBe(1);
    expect(roundStorage.getMessages(started.discussionId).some((message) => message.content === 'must not be retained')).toBe(false);
    await expect(roundCollaboration.retryDiscussion({
      discussionId: started.discussionId,
      agent: 'claude',
    })).rejects.toThrow('maxTurns budget');
    roundStorage.close();
  });

  it('keeps one cancellable provider request per asynchronous discussion', async () => {
    const asyncStorage = new Storage(':memory:');
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const asyncCollaboration = new CollaborationService(
      asyncStorage,
      new AuditService(asyncStorage),
      { asyncDispatch: true, timeoutMs: 5_000 },
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async () => {
            await providerGate;
            return { content: 'async response', duration: 1 };
          },
        },
      },
    );
    const started = await asyncCollaboration.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'single flight',
      initialMessage: 'first request',
      traceId: 'tr_single_flight',
    });

    expect(['QUEUED', 'RUNNING']).toContain(asyncStorage.getDiscussion(started.discussionId)?.dispatchState);
    await expect(asyncCollaboration.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'too soon',
    })).rejects.toMatchObject({ code: 'BUSY' });
    expect(asyncStorage.getMessages(started.discussionId)).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(asyncStorage.getMessages(started.discussionId).at(-1)?.content).toBe('async response');
    expect(asyncStorage.getDiscussion(started.discussionId)?.dispatchState).toBe('COMPLETED');
    asyncStorage.close();
  });

  it('cancels an in-flight provider request through its abort signal', async () => {
    const cancelStorage = new Storage(':memory:');
    const connector = {
      agentType: 'codex' as const,
      isAvailable: async () => true,
      isBusy: async () => false,
      sendAndWait: async (context: { signal?: AbortSignal }) => await new Promise<never>((_, innerReject) => {
        if (context.signal?.aborted) {
          innerReject(new Error('cancelled by test'));
          return;
        }
        context.signal?.addEventListener('abort', () => innerReject(new Error('cancelled by test')), { once: true });
      }),
    };
    const service = new CollaborationService(
      cancelStorage,
      new AuditService(cancelStorage),
      { timeoutMs: 5_000 },
      { codex: connector },
    );
    const pending = service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'cancel provider',
      initialMessage: 'wait',
      traceId: 'tr_cancel_provider',
    });
    const discussion = cancelStorage.listDiscussions()[0];
    await service.cancelDiscussion({ discussionId: discussion.id, agent: 'claude' });
    await expect(pending).rejects.toThrow('cancelled by test');
    expect(cancelStorage.listDiscussions()[0].status).toBe('CANCELLED');
    cancelStorage.close();
  });

  it('does not report cancellation success when the provider cannot be stopped', async () => {
    const cancelStorage = new Storage(':memory:');
    const service = new CollaborationService(
      cancelStorage,
      new AuditService(cancelStorage),
      { timeoutMs: 1_000 },
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async () => await new Promise<never>(() => {}),
          cancel: async () => { throw new Error('provider ignored cancellation'); },
        },
      },
    );
    const pending = service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'unconfirmed cancel',
      initialMessage: 'wait forever',
      traceId: 'tr_unconfirmed_cancel',
    });
    const discussion = cancelStorage.listDiscussions()[0];
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });

    await expect(service.cancelDiscussion({
      discussionId: discussion.id,
      agent: 'claude',
    })).rejects.toThrow('could not be confirmed');
    await pendingRejection;
    expect(cancelStorage.getDiscussion(discussion.id)?.status).toBe('NEEDS_USER_DECISION');
    cancelStorage.close();
  });

  it('does not claim cancellation of a provider owned by another MCP process', async () => {
    const remoteStorage = new Storage(':memory:');
    const service = new CollaborationService(remoteStorage, new AuditService(remoteStorage));
    const started = await service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'remote provider',
      initialMessage: 'running elsewhere',
      traceId: 'tr_remote_provider',
    });
    remoteStorage.acquireSessionLease({
      provider: 'codex',
      projectPath: process.cwd(),
      ownerId: started.discussionId,
    });

    await expect(service.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'must not race',
    })).rejects.toThrow('already leased');
    expect(remoteStorage.getMessages(started.discussionId)).toHaveLength(1);
    await expect(service.cancelDiscussion({
      discussionId: started.discussionId,
      agent: 'claude',
    })).rejects.toThrow('could not be confirmed');
    expect(remoteStorage.getDiscussion(started.discussionId)?.status).toBe('NEEDS_USER_DECISION');
    remoteStorage.releaseSessionLease('codex', process.cwd(), started.discussionId);
    remoteStorage.close();
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
    expect(retryStorage.getDiscussion(discussionId)?.dispatchState).toBe('FAILED');
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

  it('marks a superseded provider session UNKNOWN after backend fallback', async () => {
    const fallbackStorage = new Storage(':memory:');
    const discussion = fallbackStorage.createDiscussion({
      topic: 'fallback status',
      driver: 'claude',
      peer: 'codex',
      projectPath: process.cwd(),
      traceId: 'tr_fallback_status',
    });
    fallbackStorage.registerSession({
      provider: 'codex',
      sessionId: 'thread_old_app_server',
      projectPath: process.cwd(),
      status: 'IDLE',
      metadata: {
        sessionKind: 'codex-app-server',
        bridgeOwned: true,
        discussionId: discussion.id,
      },
    });
    const fallbackCollaboration = new CollaborationService(
      fallbackStorage,
      new AuditService(fallbackStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async () => ({
            content: 'fallback response',
            duration: 1,
            providerSessionId: 'thread_new_cli',
            providerSessionKind: 'codex-cli',
            backendSwitched: { from: 'app-server', to: 'cli', reason: 'fixture failure' },
          }),
        },
      },
    );

    await fallbackCollaboration.replyToDiscussion({
      discussionId: discussion.id,
      sender: 'claude',
      reply: 'trigger fallback',
    });

    expect(fallbackStorage.getSession('codex', 'thread_old_app_server')?.status).toBe('UNKNOWN');
    expect(fallbackStorage.getSession('codex', 'thread_new_cli')?.status).toBe('IDLE');
    expect(fallbackStorage.getSession('codex', 'thread_new_cli')?.metadata.sessionKind).toBe('codex-cli');
    fallbackStorage.close();
  });

  it.each([
    ['review', 3],
    ['discussion', 12],
    ['deep-discussion', 20],
  ] as const)('persists %s mode with its default safety ceiling', async (mode, maxTurns) => {
    const modeStorage = new Storage(':memory:');
    const prompts: string[] = [];
    const service = new CollaborationService(
      modeStorage,
      new AuditService(modeStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async ({ prompt }) => {
            prompts.push(prompt);
            return { content: 'reviewed\n[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]', duration: 1 };
          },
        },
      },
    );

    const started = await service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: `${mode} defaults`,
      initialMessage: 'Inspect this decision.',
      traceId: `tr_${mode}`,
      mode,
    });

    expect(started).toMatchObject({ mode, maxTurns });
    expect(modeStorage.getDiscussion(started.discussionId)).toMatchObject({ mode, maxTurns });
    expect(prompts[0]).toContain(`mode: ${mode}`);
    expect(prompts[0]).toContain(`0/${maxTurns}`);
    expect(modeStorage.getAuditLog(started.discussionId).find((event) => event.action === 'peer.response')?.metadata)
      .toMatchObject({ mode, signal: 'READY_TO_CLOSE' });
    modeStorage.close();
  });

  it('lets an explicit service ceiling override mode defaults', async () => {
    const configuredStorage = new Storage(':memory:');
    const service = new CollaborationService(configuredStorage, new AuditService(configuredStorage), { maxTurns: 7 });
    const started = await service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'configured ceiling',
      initialMessage: 'Review with a service ceiling.',
      traceId: 'tr_configured_ceiling',
      mode: 'review',
    });
    expect(started.maxTurns).toBe(7);
    expect(configuredStorage.getDiscussion(started.discussionId)?.maxTurns).toBe(7);
    configuredStorage.close();
  });

  it('pauses safely when the peer returns a user-owned decision signal', async () => {
    const signalStorage = new Storage(':memory:');
    let attempts = 0;
    const service = new CollaborationService(
      signalStorage,
      new AuditService(signalStorage),
      {},
      {
        codex: {
          agentType: 'codex',
          isAvailable: async () => true,
          isBusy: async () => false,
          sendAndWait: async () => {
            attempts += 1;
            return {
              content: attempts === 1
                ? 'Choose whether downtime is acceptable.\n[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]'
                : 'Use the online migration.\n[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]',
              duration: 1,
            };
          },
        },
      },
    );
    const started = await service.initiateDiscussion({
      driver: 'claude',
      peer: 'codex',
      topic: 'user-owned risk',
      initialMessage: 'Choose a migration strategy.',
      traceId: 'tr_user_signal',
      mode: 'deep-discussion',
    });

    expect(started.status).toBe('NEEDS_USER_DECISION');
    expect(signalStorage.getDiscussion(started.discussionId)).toMatchObject({
      status: 'NEEDS_USER_DECISION',
      dispatchState: 'COMPLETED',
      lastSignal: 'NEEDS_USER_DECISION',
      stopReason: 'PEER_REQUESTED_USER_DECISION',
    });
    const resumed = await service.replyToDiscussion({
      discussionId: started.discussionId,
      sender: 'claude',
      reply: 'Downtime is not acceptable; use an online path.',
    });
    expect(resumed.status).toBe('DISCUSSING');
    expect(signalStorage.getDiscussion(started.discussionId)).toMatchObject({
      status: 'DISCUSSING',
      lastSignal: 'READY_TO_CLOSE',
      stopReason: null,
    });
    expect(signalStorage.getAuditLog(started.discussionId).some((event) => (
      event.action === 'discussion.user_decision_resumed'
      && event.metadata.previousStopReason === 'PEER_REQUESTED_USER_DECISION'
    ))).toBe(true);
    signalStorage.close();
  });
});
