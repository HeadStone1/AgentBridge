import { beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../packages/storage/src/index';
import { AuditService } from '../../packages/audit/src/index';
import { CollaborationService } from '../../packages/collaboration/src/index';
import { ProviderError } from '../../packages/protocol/src/index';
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
      Û5¶‰žËkºwµç@½¹ÍÐÉ•ÑÉå½±±…‰½É…Ñ¥½¸€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€É•ÑÉåMÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡É•ÑÉåMÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€¡½¹Ñ•áÐ¤€ôøì(€€€€€€€€€€€…ÑÑ•µÁÑÌ€¬ô€Äì(€€€€€€€€€€€¥˜€¡…ÑÑ•µÁÑÌ€ôôô€Ä¤Ñ¡É½Ü¹•ÜÉÉ½È Í¥µÕ±…Ñ•½¹¹•Ñ½È™…¥±ÕÉ”œ¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€½¹Ñ•¹Ðè€É•ÑÉäÍÕ••‘•œ°(€€€€€€€€€€€€€‘ÕÉ…Ñ¥½¸è€Ä°(€€€€€€€€€€€ôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì((€€€±•Ð‘¥ÍÕÍÍ¥½¹%€ô€œœì(€€€…Ý…¥Ð•áÁ•Ð¡É•ÑÉå½±±…‰½É…Ñ¥½¸¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€É•ÑÉäœ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€É•ÑÉäµ”œ°(€€€€€ÑÉ…•%è€ÑÉ}É•ÑÉäœ°(€€€ô¤¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü Í¥µÕ±…Ñ•½¹¹•Ñ½È™…¥±ÕÉ”œ¤ì(€€€‘¥ÍÕÍÍ¥½¹%€ôÉ•ÑÉåMÑ½É…”¹±¥ÍÑ¥ÍÕÍÍ¥½¹Ì ¥lÁt¹¥ì(€€€•áÁ•Ð¡É•ÑÉåMÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡‘¥ÍÕÍÍ¥½¹%¤ü¹ÍÑ…ÑÕÌ¤¹Ñ½	” %1œ¤ì(€€€•áÁ•Ð¡É•ÑÉåMÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡‘¥ÍÕÍÍ¥½¹%¤ü¹‘¥ÍÁ…Ñ¡MÑ…Ñ”¤¹Ñ½	” %1œ¤ì(€€€•áÁ•Ð¡É•ÑÉåMÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡‘¥ÍÕÍÍ¥½¹%¤ü¹É•ÑÉå½Õ¹Ð¤¹Ñ½	” Ä¤ì(€€€•áÁ•Ð¡É•ÑÉåMÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€™…¥±•‘¥ÍÁ…Ñ¡I••¥Ù•Èè€½‘•àœ°(€€€€€™…¥±•‘5•ÍÍ…•%èÉ•ÑÉåMÑ½É…”¹•Ñ5•ÍÍ…•Ì¡‘¥ÍÕÍÍ¥½¹%¥lÁt¹¥°(€€€€€™…¥±•‘=Á•É…Ñ¥½¹-¥¹è€Á••É}µ•ÍÍ…”œ°(€€€ô¤ì((€€€½¹ÍÐÉ•ÑÉ¥•€ô…Ý…¥ÐÉ•ÑÉå½±±…‰½É…Ñ¥½¸¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì‘¥ÍÕÍÍ¥½¹%°…•¹Ðè€±…Õ‘”œô¤ì(€€€•áÁ•Ð¡É•ÑÉ¥•¹ÍÑ…ÑÕÌ¤¹Ñ½	” %MUMM%9œ¤ì(€€€•áÁ•Ð¡É•ÑÉ¥•¹É•ÑÉå½Õ¹Ð¤¹Ñ½	” Ä¤ì(€€€•áÁ•Ð¡É•ÑÉ¥•¹Á••ÉI•ÍÁ½¹Í”ü¹½¹Ñ•¹Ð¤¹Ñ½	” É•ÑÉäÍÕ••‘•œ¤ì(€€€•áÁ•Ð¡…ÑÑ•µÁÑÌ¤¹Ñ½	” È¤ì(€€€•áÁ•Ð¡É•ÑÉåMÑ½É…”¹•Ñ5•ÍÍ…•Ì¡‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½!…Ù•1•¹Ñ  È¤ì(€€€É•ÑÉåMÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð ­••ÁÌ±•…ä™…¥±•‘¥ÍÕÍÍ¥½¹ÌÉ•ÑÉå…‰±”Ý¡•¸‘¥ÍÁ…Ñ µ•Ñ…‘…Ñ„¥Ì…‰Í•¹Ðœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±•…åMÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€±•Ð…ÑÑ•µÁÑÌ€ô€Àì(€€€½¹ÍÐ±•…å½±±…‰½É…Ñ¥½¸€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€±•…åMÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡±•…åMÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…ÑÑ•µÁÑÌ€¬ô€Äì(€€€€€€€€€€€¥˜€¡…ÑÑ•µÁÑÌ€ôôô€Ä¤Ñ¡É½Ü¹•ÜÉÉ½È ±•…ä½¹¹•Ñ½È™…¥±ÕÉ”œ¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì½¹Ñ•¹Ðè€±•…äÉ•ÑÉäÍÕ••‘•œ°‘ÕÉ…Ñ¥½¸è€Äôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì((€€€…Ý…¥Ð•áÁ•Ð¡±•…å½±±…‰½É…Ñ¥½¸¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€±•…äÉ•ÑÉäœ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€É•ÑÉä±•…äÉ•ÅÕ•ÍÐœ°(€€€€€ÑÉ…•%è€ÑÉ}±•…å}É•ÑÉäœ°(€€€ô¤¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü ±•…ä½¹¹•Ñ½È™…¥±ÕÉ”œ¤ì(€€€½¹ÍÐ‘¥ÍÕÍÍ¥½¸€ô±•…åMÑ½É…”¹±¥ÍÑ¥ÍÕÍÍ¥½¹Ì ¥lÁtì(€€€½¹ÍÐ‘…Ñ…‰…Í”€ô€¡±•…åMÑ½É…”…ÌÕ¹­¹½Ý¸…Ìì(€€€€€‘ˆèìÁÉ•Á…É”¡ÍÅ°èÍÑÉ¥¹œ¤èìÉÕ¸ ¸¸¹Á…É…µÌèÕ¹­¹½Ý¹mt¤èÕ¹­¹½Ý¸ôôì(€€€ô¤¹‘ˆì(€€€‘…Ñ…‰…Í”¹ÁÉ•Á…É” (€€€€€€UAQ‘¥ÍÕÍÍ¥½¹ÌMP™…¥±•‘}‘¥ÍÁ…Ñ¡}É••¥Ù•È€ô9U10°™…¥±•‘}µ•ÍÍ…•}¥€ô9U10°™…¥±•‘}½Á•É…Ñ¥½¹}­¥¹€ô9U10]!I¥€ô€üœ°(€€€€¤¹ÉÕ¸¡‘¥ÍÕÍÍ¥½¸¹¥¤ì((€€€½¹ÍÐÉ•ÑÉ¥•€ô…Ý…¥Ð±•…å½±±…‰½É…Ñ¥½¸¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%è‘¥ÍÕÍÍ¥½¸¹¥°(€€€€€…•¹Ðè€±…Õ‘”œ°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÑÉ¥•¹Á••ÉI•ÍÁ½¹Í”ü¹½¹Ñ•¹Ð¤¹Ñ½	” ±•…äÉ•ÑÉäÍÕ••‘•œ¤ì(€€€•áÁ•Ð¡…ÑÑ•µÁÑÌ¤¹Ñ½	” È¤ì(€€€±•…åMÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð É•ÑÉ¥•Ì„É•ÑÉå…‰±”¹½¸µ…µ‰¥Õ½ÕÌÁÉ½Ù¥‘•ÈÑ¥µ•½ÕÐœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÑ¥µ•½ÕÑMÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€±•Ð…ÑÑ•µÁÑÌ€ô€Àì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€Ñ¥µ•½ÕÑMÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡Ñ¥µ•½ÕÑMÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…ÑÑ•µÁÑÌ€¬ô€Äì(€€€€€€€€€€€¥˜€¡…ÑÑ•µÁÑÌ€ôôô€Ä¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¹•ÜAÉ½Ù¥‘•ÉÉÉ½È Q%5=UPœ°€ÁÉ½Ù¥‘•ÈÑ¥µ•½ÕÐœ°ì(€€€€€€€€€€€€€€€É•ÑÉå…‰±”èÑÉÕ”°(€€€€€€€€€€€€€€€…µ‰¥Õ½ÕÌè™…±Í”°(€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€É•ÑÕÉ¸ì½¹Ñ•¹Ðè€Ñ¥µ•½ÕÐÉ•ÑÉäÍÕ••‘•œ°‘ÕÉ…Ñ¥½¸è€Äôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€½¹ÍÐÁ•¹‘¥¹œ€ôÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€É•ÑÉå…‰±”Ñ¥µ•½ÕÐœ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€I•ÑÉäÑ¡¥ÌÑ¥µ•½ÕÐ¸œ°(€€€€€ÑÉ…•%è€ÑÉ}É•ÑÉå…‰±•}Ñ¥µ•½ÕÐœ°(€€€ô¤ì(€€€…Ý…¥Ð•áÁ•Ð¡Á•¹‘¥¹œ¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€Q%5=UPœô¤ì(€€€½¹ÍÐ‘¥ÍÕÍÍ¥½¸€ôÑ¥µ•½ÕÑMÑ½É…”¹±¥ÍÑ¥ÍÕÍÍ¥½¹Ì ¥lÁtì(€€€•áÁ•Ð¡‘¥ÍÕÍÍ¥½¸¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€Q%5=UPœ°(€€€€€±…ÍÑÉÉ½ÈèìÉ•ÑÉå…‰±”èÑÉÕ”°…µ‰¥Õ½ÕÌè™…±Í”ô°(€€€€€™…¥±•‘¥ÍÁ…Ñ¡I••¥Ù•Èè€½‘•àœ°(€€€ô¤ì(€€€½¹ÍÐÉ•ÑÉ¥•€ô…Ý…¥ÐÍ•ÉÙ¥”¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì‘¥ÍÕÍÍ¥½¹%è‘¥ÍÕÍÍ¥½¸¹¥°…•¹Ðè€±…Õ‘”œô¤ì(€€€•áÁ•Ð¡É•ÑÉ¥•¹Á••ÉI•ÍÁ½¹Í”ü¹½¹Ñ•¹Ð¤¹Ñ½	” Ñ¥µ•½ÕÐÉ•ÑÉäÍÕ••‘•œ¤ì(€€€•áÁ•Ð¡…ÑÑ•µÁÑÌ¤¹Ñ½	” È¤ì(€€€Ñ¥µ•½ÕÑMÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð ‘½•Ì¹½ÐÉ•ÑÉä„Á••ÈµÉ•ÅÕ•ÍÑ•ÕÍ•È‘•¥Í¥½¸½ÈÉ•Á±…ä¥ÐÑ¼Ñ¡”ÝÉ½¹œÁÉ½Ù¥‘•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ¥¹…±MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€±•Ð…ÑÑ•µÁÑÌ€ô€Àì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€Í¥¹…±MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡Í¥¹…±MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…ÑÑ•µÁÑÌ€¬ô€Äì(€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€½¹Ñ•¹Ðè€¡½½Í”„Á…Ñ ¹q¹m9Q	I%}M%90è9M}UMI}%M%=9tœ°(€€€€€€€€€€€€€‘ÕÉ…Ñ¥½¸è€Ä°(€€€€€€€€€€€ôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€É•ÑÉä‘¥É•Ñ¥½¸œ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€¡½½Í”„Á…Ñ ¸œ°(€€€€€ÑÉ…•%è€ÑÉ}É•ÑÉå}‘¥É•Ñ¥½¸œ°(€€€ô¤ì((€€€…Ý…¥Ð•áÁ•Ð¡Í•ÉÙ¥”¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€…•¹Ðè€±…Õ‘”œ°(€€€ô¤¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü •áÁ±¥¥ÐÉ•Á±å}Á••È‘•¥Í¥½¸œ¤ì(€€€•áÁ•Ð¡…ÑÑ•µÁÑÌ¤¹Ñ½	” Ä¤ì(€€€•áÁ•Ð¡Í¥¹…±MÑ½É…”¹•Ñ5•ÍÍ…•Ì¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¹…Ð ´Ä¤ü¹É••¥Ù•È¤¹Ñ½	” ±…Õ‘”œ¤ì(€€€Í¥¹…±MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð ‘½•Ì¹½ÐÉ•ÑÉä…¸…µ‰¥Õ½ÕÌÁÉ½Ù¥‘•ÈÉ•ÍÕ±Ðœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ…µ‰¥Õ½ÕÍMÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€…µ‰¥Õ½ÕÍMÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡…µ‰¥Õ½ÕÍMÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€Ñ¡É½Ü¹•ÜAÉ½Ù¥‘•ÉÉÉ½È %1œ°€ÑÕÉ¸ÍÑ…ÉÑ•‰•™½É”ÑÉ…¹ÍÁ½ÉÐ™…¥±ÕÉ”œ°ì(€€€€€€€€€€€€€…µ‰¥Õ½ÕÌèÑÉÕ”°(€€€€€€€€€€€ô¤ì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€½¹ÍÐÁ•¹‘¥¹œ€ôÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€…µ‰¥Õ½ÕÌÉ•ÑÉäœ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€IÕ¸Ñ¡”½Á•É…Ñ¥½¸¸œ°(€€€€€ÑÉ…•%è€ÑÉ}…µ‰¥Õ½ÕÍ}É•ÑÉäœ°(€€€ô¤ì(€€€…Ý…¥Ð•áÁ•Ð¡Á•¹‘¥¹œ¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü ÑÕÉ¸ÍÑ…ÉÑ•‰•™½É”ÑÉ…¹ÍÁ½ÉÐ™…¥±ÕÉ”œ¤ì(€€€½¹ÍÐ‘¥ÍÕÍÍ¥½¸€ô…µ‰¥Õ½ÕÍMÑ½É…”¹±¥ÍÑ¥ÍÕÍÍ¥½¹Ì ¥lÁtì(€€€•áÁ•Ð¡‘¥ÍÕÍÍ¥½¸¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€9M}UMI}%M%=8œ°(€€€€€±…ÍÑÉÉ½Èèì…µ‰¥Õ½ÕÌèÑÉÕ”ô°(€€€€€™…¥±•‘¥ÍÁ…Ñ¡I••¥Ù•Èè€½‘•àœ°(€€€€€™…¥±•‘=Á•É…Ñ¥½¹-¥¹è€Á••É}µ•ÍÍ…”œ°(€€€ô¤ì(€€€…Ý…¥Ð•áÁ•Ð¡Í•ÉÙ¥”¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%è‘¥ÍÕÍÍ¥½¸¹¥°(€€€€€…•¹Ðè€±…Õ‘”œ°(€€€ô¤¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü …µ‰¥Õ½ÕÌõÑÉÕ”œ¤ì(€€€…µ‰¥Õ½ÕÍMÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð É•ÍÑ½É•Ì„ÁÉ½Ù¥‘•ÈÍ•ÍÍ¥½¸™É½´ME1¥Ñ”…™Ñ•ÈÑ¡”½±±…‰½É…Ñ¥½¸ÁÉ½•ÍÌÉ•ÍÑ…ÉÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ‘¥É•Ñ½Éä€ôµ­‘Ñ•µÁMå¹Œ¡©½¥¸¡ÑµÁ‘¥È ¤°€…•¹Ñ‰É¥‘”µÍ•ÍÍ¥½¸µÉ•ÍÑ…ÉÐ´œ¤¤ì(€€€½¹ÍÐ‘‰A…Ñ €ô©½¥¸¡‘¥É•Ñ½Éä°€…•¹Ñ‰É¥‘”¹ÍÅ±¥Ñ”œ¤ì(€€€ÑÉäì(€€€€€½¹ÍÐ™¥ÉÍÑMÑ½É…”€ô¹•ÜMÑ½É…”¡‘‰A…Ñ ¤ì(€€€€€½¹ÍÐ™¥ÉÍÑ½±±…‰½É…Ñ¥½¸€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€€€™¥ÉÍÑMÑ½É…”°(€€€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡™¥ÉÍÑMÑ½É…”¤°(€€€€€€€ìÑ¥µ•½ÕÑ5Ìè€Õ|ÀÀÀô°(€€€€€€€ì½‘•àè¹•Ü½‘•á½¹¹•Ñ½È¡ì½µµ…¹èÁÉ½•ÍÌ¹•á•A…Ñ °•áÑÉ…ÉÌèm½‘•á¥áÑÕÉ•t°Ñ¥µ•½ÕÑ5Ìè€Õ|ÀÀÀô¤ô°(€€€€€€¤ì(€€€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥Ð™¥ÉÍÑ½±±…‰½É…Ñ¥½¸¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€€€Á••Èè€½‘•àœ°(€€€€€€€Ñ½Á¥Œè€É•ÍÑ…ÉÐÉ•½Ù•Éäœ°(€€€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€™¥ÉÍÐÉ½Õ¹œ°(€€€€€€€ÁÉ½©•ÑA…Ñ è‘¥É•Ñ½Éä°(€€€€€€€ÑÉ…•%è€ÑÉ}É•ÍÑ…ÉÐœ°(€€€€€ô¤ì(€€€€€™¥ÉÍÑMÑ½É…”¹±½Í” ¤ì((€€€€€½¹ÍÐÍ•½¹‘MÑ½É…”€ô¹•ÜMÑ½É…”¡‘‰A…Ñ ¤ì(€€€€€½¹ÍÐÍ•½¹‘½±±…‰½É…Ñ¥½¸€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€€€Í•½¹‘MÑ½É…”°(€€€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡Í•½¹‘MÑ½É…”¤°(€€€€€€€ìÑ¥µ•½ÕÑ5Ìè€Õ|ÀÀÀô°(€€€€€€€ì½‘•àè¹•Ü½‘•á½¹¹•Ñ½È¡ì½µµ…¹èÁÉ½•ÍÌ¹•á•A…Ñ °•áÑÉ…ÉÌèm½‘•á¥áÑÕÉ•t°Ñ¥µ•½ÕÑ5Ìè€Õ|ÀÀÀô¤ô°(€€€€€€¤ì(€€€€€½¹ÍÐ½¹Ñ¥¹Õ•€ô…Ý…¥ÐÍ•½¹‘½±±…‰½É…Ñ¥½¸¹É•Á±åQ½¥ÍÕÍÍ¥½¸¡ì(€€€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€€€Í•¹‘•Èè€±…Õ‘”œ°(€€€€€€€É•Á±äè€Í•½¹É½Õ¹œ°(€€€€€ô¤ì(€€€€€•áÁ•Ð¡½¹Ñ¥¹Õ•¹Á••ÉI•ÍÁ½¹Í”ü¹½¹Ñ•¹Ð¤¹Ñ½	” É•ÍÕµ•½‘•àÉ•ÍÁ½¹Í”œ¤ì(€€€€€•áÁ•Ð¡Í•½¹‘MÑ½É…”¹•ÑM•ÍÍ¥½¹½É¥ÍÕÍÍ¥½¸ ½‘•àœ°ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°‘¥É•Ñ½Éä¤ü¹Í•ÍÍ¥½¹%¤(€€€€€€€€¹Ñ½	” Ñ¡É•…‘}™…­•}½‘•àœ¤ì(€€€€€Í•½¹‘MÑ½É…”¹±½Í” ¤ì(€€€ô™¥¹…±±äì(€€€€€ÉµMå¹Œ¡‘¥É•Ñ½Éä°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”°™½É”èÑÉÕ”ô¤ì(€€€ô(€ô¤ì((€¥Ð µ…É­Ì„ÍÕÁ•ÉÍ•‘•ÁÉ½Ù¥‘•ÈÍ•ÍÍ¥½¸U9-9=]8…™Ñ•È‰…­•¹™…±±‰…¬œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ™…±±‰…­MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐ‘¥ÍÕÍÍ¥½¸€ô™…±±‰…­MÑ½É…”¹É•…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€Ñ½Á¥Œè€™…±±‰…¬ÍÑ…ÑÕÌœ°(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€ÁÉ½©•ÑA…Ñ èÁÉ½•ÍÌ¹Ý ¤°(€€€€€ÑÉ…•%è€ÑÉ}™…±±‰…­}ÍÑ…ÑÕÌœ°(€€€ô¤ì(€€€™…±±‰…­MÑ½É…”¹É•¥ÍÑ•ÉM•ÍÍ¥½¸¡ì(€€€€€ÁÉ½Ù¥‘•Èè€½‘•àœ°(€€€€€Í•ÍÍ¥½¹%è€Ñ¡É•…‘}½±‘}…ÁÁ}Í•ÉÙ•Èœ°(€€€€€ÁÉ½©•ÑA…Ñ èÁÉ½•ÍÌ¹Ý ¤°(€€€€€ÍÑ…ÑÕÌè€%1œ°(€€€€€µ•Ñ…‘…Ñ„èì(€€€€€€€Í•ÍÍ¥½¹-¥¹è€½‘•àµ…ÁÀµÍ•ÉÙ•Èœ°(€€€€€€€‰É¥‘•=Ý¹•èÑÉÕ”°(€€€€€€€‘¥ÍÕÍÍ¥½¹%è‘¥ÍÕÍÍ¥½¸¹¥°(€€€€€ô°(€€€ô¤ì(€€€½¹ÍÐ™…±±‰…­½±±…‰½É…Ñ¥½¸€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€™…±±‰…­MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡™…±±‰…­MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôø€¡ì(€€€€€€€€€€€½¹Ñ•¹Ðè€™…±±‰…¬É•ÍÁ½¹Í”œ°(€€€€€€€€€€€‘ÕÉ…Ñ¥½¸è€Ä°(€€€€€€€€€€€ÁÉ½Ù¥‘•ÉM•ÍÍ¥½¹%è€Ñ¡É•…‘}¹•Ý}±¤œ°(€€€€€€€€€€€ÁÉ½Ù¥‘•ÉM•ÍÍ¥½¹-¥¹è€½‘•àµ±¤œ°(€€€€€€€€€€€‰…­•¹‘MÝ¥Ñ¡•èì™É½´è€…ÁÀµÍ•ÉÙ•Èœ°Ñ¼è€±¤œ°É•…Í½¸è€™¥áÑÕÉ”™…¥±ÕÉ”œô°(€€€€€€€€€ô¤°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì((€€€…Ý…¥Ð™…±±‰…­½±±…‰½É…Ñ¥½¸¹É•Á±åQ½¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%è‘¥ÍÕÍÍ¥½¸¹¥°(€€€€€Í•¹‘•Èè€±…Õ‘”œ°(€€€€€É•Á±äè€ÑÉ¥•È™…±±‰…¬œ°(€€€ô¤ì((€€€•áÁ•Ð¡™…±±‰…­MÑ½É…”¹•ÑM•ÍÍ¥½¸ ½‘•àœ°€Ñ¡É•…‘}½±‘}…ÁÁ}Í•ÉÙ•Èœ¤ü¹ÍÑ…ÑÕÌ¤¹Ñ½	” U9-9=]8œ¤ì(€€€•áÁ•Ð¡™…±±‰…­MÑ½É…”¹•ÑM•ÍÍ¥½¸ ½‘•àœ°€Ñ¡É•…‘}¹•Ý}±¤œ¤ü¹ÍÑ…ÑÕÌ¤¹Ñ½	” %1œ¤ì(€€€•áÁ•Ð¡™…±±‰…­MÑ½É…”¹•ÑM•ÍÍ¥½¸ ½‘•àœ°€Ñ¡É•…‘}¹•Ý}±¤œ¤ü¹µ•Ñ…‘…Ñ„¹Í•ÍÍ¥½¹-¥¹¤¹Ñ½	” ½‘•àµ±¤œ¤ì(€€€™…±±‰…­MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð¹•… ¡l(€€€lÉ•Ù¥•Üœ°€Ít°(€€€l‘¥ÍÕÍÍ¥½¸œ°€ÄÉt°(€€€l‘••Àµ‘¥ÍÕÍÍ¥½¸œ°€ÈÁt°(€t…Ì½¹ÍÐ¤ Á•ÉÍ¥ÍÑÌ€•Ìµ½‘”Ý¥Ñ ¥ÑÌ‘•™…Õ±ÐÍ…™•Ñä•¥±¥¹œœ°…Íå¹Œ€¡µ½‘”°µ…áQÕÉ¹Ì¤€ôøì(€€€½¹ÍÐµ½‘•MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐÁÉ½µÁÑÌèÍÑÉ¥¹mt€ômtì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€µ½‘•MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡µ½‘•MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€¡ìÁÉ½µÁÐô¤€ôøì(€€€€€€€€€€€ÁÉ½µÁÑÌ¹ÁÕÍ ¡ÁÉ½µÁÐ¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì½¹Ñ•¹Ðè€É•Ù¥•Ý•‘q¹m9Q	I%}M%90èIe}Q=}1=Mtœ°‘ÕÉ…Ñ¥½¸è€Äôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì((€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€‘íµ½‘•ô‘•™…Õ±ÑÍ€°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€%¹ÍÁ•ÐÑ¡¥Ì‘•¥Í¥½¸¸œ°(€€€€€ÑÉ…•%èÑÉ|‘íµ½‘•õ€°(€€€€€µ½‘”°(€€€ô¤ì((€€€•áÁ•Ð¡ÍÑ…ÉÑ•¤¹Ñ½5…Ñ¡=‰©•Ð¡ìµ½‘”°µ…áQÕÉ¹Ìô¤ì(€€€•áÁ•Ð¡µ½‘•MÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ìµ½‘”°µ…áQÕÉ¹Ìô¤ì(€€€•áÁ•Ð¡ÁÉ½µÁÑÍlÁt¤¹Ñ½½¹Ñ…¥¸¡µ½‘”è€‘íµ½‘•õ€¤ì(€€€•áÁ•Ð¡ÁÉ½µÁÑÍlÁt¤¹Ñ½½¹Ñ…¥¸¡€À¼‘íµ…áQÕÉ¹Íõ€¤ì(€€€•áÁ•Ð¡µ½‘•MÑ½É…”¹•ÑÕ‘¥Ñ1½œ¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¹™¥¹ ¡•Ù•¹Ð¤€ôø•Ù•¹Ð¹…Ñ¥½¸€ôôô€Á••È¹É•ÍÁ½¹Í”œ¤ü¹µ•Ñ…‘…Ñ„¤(€€€€€€¹Ñ½5…Ñ¡=‰©•Ð¡ìµ½‘”°Í¥¹…°è€Ie}Q=}1=Mœô¤ì(€€€µ½‘•MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð ±•ÑÌ…¸•áÁ±¥¥ÐÍ•ÉÙ¥”•¥±¥¹œ½Ù•ÉÉ¥‘”µ½‘”‘•™…Õ±ÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ½¹™¥ÕÉ•‘MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥”¡½¹™¥ÕÉ•‘MÑ½É…”°¹•ÜÕ‘¥ÑM•ÉÙ¥”¡½¹™¥ÕÉ•‘MÑ½É…”¤°ìµ…áQÕÉ¹Ìè€Üô¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€½¹™¥ÕÉ••¥±¥¹œœ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€I•Ù¥•ÜÝ¥Ñ „Í•ÉÙ¥”•¥±¥¹œ¸œ°(€€€€€ÑÉ…•%è€ÑÉ}½¹™¥ÕÉ•‘}•¥±¥¹œœ°(€€€€€µ½‘”è€É•Ù¥•Üœ°(€€€ô¤ì(€€€•áÁ•Ð¡ÍÑ…ÉÑ•¹µ…áQÕÉ¹Ì¤¹Ñ½	” Ü¤ì(€€€•áÁ•Ð¡½¹™¥ÕÉ•‘MÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤ü¹µ…áQÕÉ¹Ì¤¹Ñ½	” Ü¤ì(€€€½¹™¥ÕÉ•‘MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð µ½¹½Ñ½¹¥…±±äÕÁÉ…‘•Ì‘¥ÍÕÍÍ¥½¸µ½‘”Ý¥Ñ¡½ÕÐÉ•Á±…¥¹œÑ¡”‘¥ÍÕÍÍ¥½¸œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐµ½‘•MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐÁÉ½µÁÑÌèÍÑÉ¥¹mt€ômtì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€µ½‘•MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡µ½‘•MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€¡ìÁÉ½µÁÐô¤€ôøì(€€€€€€€€€€€ÁÉ½µÁÑÌ¹ÁÕÍ ¡ÁÉ½µÁÐ¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì½¹Ñ•¹Ðè€½¹Ñ¥¹Õ•q¹m9Q	I%}M%90è=9Q%9Utœ°‘ÕÉ…Ñ¥½¸è€Äôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€µ½‘”ÕÁÉ…‘”œ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€MÑ…ÉÐ„É•Ù¥•Ü¸œ°(€€€€€ÑÉ…•%è€ÑÉ}µ½‘•}ÕÁÉ…‘”œ°(€€€€€µ½‘”è€É•Ù¥•Üœ°(€€€ô¤ì(€€€½¹ÍÐÉ•ÍÕµ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹É•Á±åQ½¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€Í•¹‘•Èè€±…Õ‘”œ°(€€€€€É•Á±äè€Í…±…Ñ”Ñ¡”…¹…±åÍ¥Ì¸œ°(€€€€€µ½‘”è€‘••Àµ‘¥ÍÕÍÍ¥½¸œ°(€€€ô¤ì((€€€•áÁ•Ð¡É•ÍÕµ•¹ÍÑ…ÑÕÌ¤¹Ñ½	” %MUMM%9œ¤ì(€€€•áÁ•Ð¡µ½‘•MÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€¥èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€µ½‘”è€‘••Àµ‘¥ÍÕÍÍ¥½¸œ°(€€€ô¤ì(€€€•áÁ•Ð¡ÁÉ½µÁÑÌ¹…Ð ´Ä¤¤¹Ñ½½¹Ñ…¥¸ µ½‘”è‘••Àµ‘¥ÍÕÍÍ¥½¸œ¤ì(€€€…Ý…¥Ð•áÁ•Ð¡Í•ÉÙ¥”¹É•Á±åQ½¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€Í•¹‘•Èè€±…Õ‘”œ°(€€€€€É•Á±äè€½Ý¹É…‘”Ñ¡”…¹…±åÍ¥Ì¸œ°(€€€€€µ½‘”è€‘¥ÍÕÍÍ¥½¸œ°(€€€ô¤¤¹É•©•ÑÌ¹Ñ½Q¡É½Ü …¹¹½Ð‰”‘½Ý¹É…‘•œ¤ì(€€€µ½‘•MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð Á…ÕÍ•ÌÍ…™•±äÝ¡•¸Ñ¡”Á••ÈÉ•ÑÕÉ¹Ì„ÕÍ•Èµ½Ý¹•‘•¥Í¥½¸Í¥¹…°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ¥¹…±MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€±•Ð…ÑÑ•µÁÑÌ€ô€Àì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€Í¥¹…±MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡Í¥¹…±MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€…ÑÑ•µÁÑÌ€¬ô€Äì(€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€½¹Ñ•¹Ðè…ÑÑ•µÁÑÌ€ôôô€Ä(€€€€€€€€€€€€€€€€ü€¡½½Í”Ý¡•Ñ¡•È‘½Ý¹Ñ¥µ”¥Ì…•ÁÑ…‰±”¹q¹m9Q	I%}M%90è9M}UMI}%M%=9tœ(€€€€€€€€€€€€€€€€è€UÍ”Ñ¡”½¹±¥¹”µ¥É…Ñ¥½¸¹q¹m9Q	I%}M%90èIe}Q=}1=Mtœ°(€€€€€€€€€€€€€‘ÕÉ…Ñ¥½¸è€Ä°(€€€€€€€€€€€ôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€ÕÍ•Èµ½Ý¹•É¥Í¬œ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€¡½½Í”„µ¥É…Ñ¥½¸ÍÑÉ…Ñ•ä¸œ°(€€€€€ÑÉ…•%è€ÑÉ}ÕÍ•É}Í¥¹…°œ°(€€€€€µ½‘”è€‘••Àµ‘¥ÍÕÍÍ¥½¸œ°(€€€ô¤ì((€€€•áÁ•Ð¡ÍÑ…ÉÑ•¹ÍÑ…ÑÕÌ¤¹Ñ½	” 9M}UMI}%M%=8œ¤ì(€€€•áÁ•Ð¡Í¥¹…±MÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€9M}UMI}%M%=8œ°(€€€€€‘¥ÍÁ…Ñ¡MÑ…Ñ”è€=5A1Qœ°(€€€€€±…ÍÑM¥¹…°è€9M}UMI}%M%=8œ°(€€€€€ÍÑ½ÁI•…Í½¸è€AI}IEUMQ}UMI}%M%=8œ°(€€€ô¤ì(€€€½¹ÍÐÉ•ÍÕµ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹É•Á±åQ½¥ÍÕÍÍ¥½¸¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€Í•¹‘•Èè€±…Õ‘”œ°(€€€€€É•Á±äè€½Ý¹Ñ¥µ”¥Ì¹½Ð…•ÁÑ…‰±”ìÕÍ”…¸½¹±¥¹”Á…Ñ ¸œ°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÕµ•¹ÍÑ…ÑÕÌ¤¹Ñ½	” %MUMM%9œ¤ì(€€€•áÁ•Ð¡Í¥¹…±MÑ½É…”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€%MUMM%9œ°(€€€€€±…ÍÑM¥¹…°è€Ie}Q=}1=Mœ°(€€€€€ÍÑ½ÁI•…Í½¸è¹Õ±°°(€€€ô¤ì(€€€•áÁ•Ð¡Í¥¹…±MÑ½É…”¹•ÑÕ‘¥Ñ1½œ¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¹Í½µ” ¡•Ù•¹Ð¤€ôø€ (€€€€€•Ù•¹Ð¹…Ñ¥½¸€ôôô€‘¥ÍÕÍÍ¥½¸¹ÕÍ•É}‘•¥Í¥½¹}É•ÍÕµ•œ(€€€€€€˜˜•Ù•¹Ð¹µ•Ñ…‘…Ñ„¹ÁÉ•Ù¥½ÕÍMÑ½ÁI•…Í½¸€ôôô€AI}IEUMQ}UMI}%M%=8œ(€€€€¤¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€Í¥¹…±MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð Á•ÉÍ¥ÍÑÌÁÉ½Ù¥‘•È…Ñ¥Ù¥Ñä…¹É•ÑÕÉ¹Ì„½µÁ±•Ñ•Á••ÈÉÕ¹Ñ¥µ”Í¹…ÁÍ¡½Ðœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉÕ¹Ñ¥µ•MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€ÉÕ¹Ñ¥µ•MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡ÉÕ¹Ñ¥µ•MÑ½É…”¤°(€€€€€íô°(€€€€€ì(€€€€€€€½‘•àèì(€€€€€€€€€…•¹ÑQåÁ”è€½‘•àœ°(€€€€€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€¡ì½¹Ñ¥Ù¥Ñäô¤€ôøì(€€€€€€€€€€€½¹Ñ¥Ù¥Ñäü¸¡ì­¥¹è€ÁÉ½•ÍÍ}ÍÑ…ÉÑ•œ°ÁÉ½•ÍÍ±¥Ù”èÑÉÕ”°½¹¹•Ñ¥½¹±¥Ù”èÑÉÕ”ô¤ì(€€€€€€€€€€€½¹Ñ¥Ù¥Ñäü¸¡ì­¥¹è€½ÕÑÁÕÐœ°ÁÉ½•ÍÍ±¥Ù”èÑÉÕ”°½¹¹•Ñ¥½¹±¥Ù”èÑÉÕ”ô¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì½¹Ñ•¹Ðè€ÉÕ¹Ñ¥µ”É•ÍÁ½¹Í”œ°‘ÕÉ…Ñ¥½¸è€Äôì(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì((€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€ÉÕ¹Ñ¥µ”œ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€I•Á½ÉÐÉÕ¹Ñ¥µ”ÍÑ…Ñ”¸œ°(€€€€€ÑÉ…•%è€ÑÉ}ÉÕ¹Ñ¥µ•}½µÁ±•Ñ•œ°(€€€ô¤ì(€€€•áÁ•Ð ¡…Ý…¥ÐÍ•ÉÙ¥”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Á••ÉIÕ¹Ñ¥µ”¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°(€€€€€ÁÉ½Ù¥‘•Èè€½‘•àœ°(€€€€€ÍÑ…Ñ”è€=5A1Qœ°(€€€€€ÁÉ½•ÍÍ±¥Ù”è™…±Í”°(€€€ô¤ì(€€€ÉÕ¹Ñ¥µ•MÑ½É…”¹±½Í” ¤ì(€ô¤ì((€¥Ð µ½Ù•ÌÍ¥±•¹ÐÁÉ½Ù¥‘•ÉÌÑ¡É½Õ %1}MUMAQÑ¼MQ11…¹‰±½­ÌÉ•ÑÉäÝ¡¥±”…Ñ¥Ù”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉÕ¹Ñ¥µ•MÑ½É…”€ô¹•ÜMÑ½É…” œéµ•µ½Éäèœ¤ì(€€€½¹ÍÐ½¹™¥œ€ôì(€€€€€…Íå¹¥ÍÁ…Ñ èÑÉÕ”°(€€€€€ÍÑ…ÉÑÕÁQ¥µ•½ÕÑ5Ìè€Õ|ÀÀÀ°(€€€€€¥‘±•Q¥µ•½ÕÑ5Ìè€Å|ÀÀÀ°(€€€€€ÍÑ…±±É…•5Ìè€Å|ÀÀÀ°(€€€€€ÑÕÉ¹!…É‘1¥µ¥Ñ5Ìè€ÄÁ|ÀÀÀ°(€€€ôì(€€€½¹ÍÐ½¹¹•Ñ½È€ôì(€€€€€…•¹ÑQåÁ”è€½‘•àœ…Ì½¹ÍÐ°(€€€€€¥ÍÙ…¥±…‰±”è…Íå¹Œ€ ¤€ôøÑÉÕ”°(€€€€€¥Í	ÕÍäè…Íå¹Œ€ ¤€ôø™…±Í”°(€€€€€Í•¹‘¹‘]…¥Ðè…Íå¹Œ€¡ì½¹Ñ¥Ù¥Ñä°Í¥¹…°ôèì½¹Ñ¥Ù¥Ñäüè€¡…Ñ¥Ù¥Ñäè…¹ä¤€ôøÙ½¥ìÍ¥¹…°üè‰½ÉÑM¥¹…°ô¤€ôø…Ý…¥Ð¹•ÜAÉ½µ¥Í”ñ¹•Ù•Èø ¡|°É•©•Ð¤€ôøì(€€€€€€€½¹Ñ¥Ù¥Ñäü¸¡ì­¥¹è€ÁÉ½•ÍÍ}ÍÑ…ÉÑ•œ°ÁÉ½•ÍÍ±¥Ù”èÑÉÕ”°½¹¹•Ñ¥½¹±¥Ù”èÑÉÕ”ô¤ì(€€€€€€€Í¥¹…°ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È …‰½ÉÐœ°€ ¤€ôøÉ•©•Ð¡¹•ÜAÉ½Ù¥‘•ÉÉÉ½È Q%5=UPœ°€Ñ•ÍÐÍÑ…±±•œ¤¤°ì½¹”èÑÉÕ”ô¤ì(€€€€€ô¤°(€€€ôì(€€€½¹ÍÐÍ•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€ÉÕ¹Ñ¥µ•MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡ÉÕ¹Ñ¥µ•MÑ½É…”¤°(€€€€€½¹™¥œ°(€€€€€ì½‘•àè½¹¹•Ñ½Èô°(€€€€¤ì((€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ý…¥ÐÍ•ÉÙ¥”¹¥¹¥Ñ¥…Ñ•¥ÍÕÍÍ¥½¸¡ì(€€€€€‘É¥Ù•Èè€±…Õ‘”œ°(€€€€€Á••Èè€½‘•àœ°(€€€€€Ñ½Á¥Œè€ÉÕ¹Ñ¥µ”ÍÑ…±°œ°(€€€€€¥¹¥Ñ¥…±5•ÍÍ…”è€]…¥Ð™½ÈÑ¡”Í¥±•¹ÐÁ••È¸œ°(€€€€€ÑÉ…•%è€ÑÉ}ÉÕ¹Ñ¥µ•}ÍÑ…±°œ°(€€€ô¤ì(€€€ÉÕ¹Ñ¥µ•MÑ½É…”¹ÕÁ‘…Ñ•¥ÍÕÍÍ¥½¹MÑ…ÑÕÌ¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°€Q%5=UPœ¤ì(€€€½¹ÍÐÉ•ÑÉåM•ÉÙ¥”€ô¹•Ü½±±…‰½É…Ñ¥½¹M•ÉÙ¥” (€€€€€ÉÕ¹Ñ¥µ•MÑ½É…”°(€€€€€¹•ÜÕ‘¥ÑM•ÉÙ¥”¡ÉÕ¹Ñ¥µ•MÑ½É…”¤°(€€€€€½¹™¥œ°(€€€€€ì½‘•àè½¹¹•Ñ½Èô°(€€€€¤ì(€€€…Ý…¥Ð•áÁ•Ð¡É•ÑÉåM•ÉÙ¥”¹É•ÑÉå¥ÍÕÍÍ¥½¸¡ì‘¥ÍÕÍÍ¥½¹%èÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%°…•¹Ðè€±…Õ‘”œô¤¤(€€€€€€¹É•©•ÑÌ¹Ñ½Q¡É½Ü AI}MQ%11}IU99%9œ¤ì((€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°€Å|ÈÀÀ¤¤ì(€€€•áÁ•Ð ¡…Ý…¥ÐÍ•ÉÙ¥”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Á••ÉIÕ¹Ñ¥µ”ü¹ÍÑ…Ñ”¤(€€€€€€¹Ñ½	” %1}MUMAQœ¤ì(€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°€Å|ÈÀÀ¤¤ì(€€€•áÁ•Ð ¡…Ý…¥ÐÍ•ÉÙ¥”¹•Ñ¥ÍÕÍÍ¥½¸¡ÍÑ…ÉÑ•¹‘¥ÍÕÍÍ¥½¹%¤¤¹Á••ÉIÕ¹Ñ¥µ”ü¹ÍÑ…Ñ”¤(€€€€€€¹Ñ½	” MQ11œ¤ì(€€€…Ý…¥ÐÍ•ÉÙ¥”¹Í¡ÕÑ‘½Ý¸ Å|ÀÀÀ¤ì(€€€…Ý…¥ÐÉ•ÑÉåM•ÉÙ¥”¹Í¡ÕÑ‘½Ý¸ Å|ÀÀÀ¤ì(€€€ÉÕ¹Ñ¥µ•MÑ½É…”¹±½Í” ¤ì(€ô¤ì)ô¤ì(