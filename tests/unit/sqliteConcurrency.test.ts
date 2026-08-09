import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Storage } from '@agentbridge/storage';

describe('SQLite dual-process safety', () => {
  it('keeps two stdio-equivalent storage owners consistent under interleaved writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-concurrency-'));
    const dbPath = join(directory, 'shared.sqlite');
    const first = new Storage(dbPath);
    const second = new Storage(dbPath);

    try {
      const discussion = first.createDiscussion({
        topic: 'dual stdio',
        driver: 'claude',
        peer: 'codex',
        projectPath: directory,
        traceId: 'tr_dual_stdio',
        maxTurns: 20,
      });

      for (let index = 0; index < 10; index += 1) {
        const owner = index % 2 === 0 ? first : second;
        const sender = index % 2 === 0 ? 'claude' : 'codex';
        const receiver = sender === 'claude' ? 'codex' : 'claude';
        owner.createMessage({
          discussionId: discussion.id,
          sender,
          receiver,
          role: index === 0 ? 'proposal' : 'response',
          content: `round-${index}`,
          projectPath: directory,
          providerSessionId: `${sender}-session`,
        });
        owner.appendAudit({
          traceId: discussion.traceId,
          discussionId: discussion.id,
          action: 'message.sent',
          agent: sender,
          metadata: { index },
        });
      }

      expect(first.getMessages(discussion.id)).toHaveLength(10);
      expect(second.getMessages(discussion.id)).toHaveLength(10);
      expect(first.getDiscussion(discussion.id)?.currentTurn).toBe(10);
      expect(second.getDiscussion(discussion.id)?.currentTurn).toBe(10);
      expect(second.getMessages(discussion.id)[9].providerSessionId).toBe('codex-session');

      first.acquireSessionLease({ provider: 'codex', projectPath: directory, ownerId: discussion.id });
      expect(() => second.acquireSessionLease({
        provider: 'codex',
        projectPath: directory,
        ownerId: 'other-discussion',
      })).toThrow('already leased');
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
