import { describe, expect, it } from 'vitest';
import { Storage } from '@agentbridge/storage';

describe('stale discussion recovery', () => {
  it('moves an abandoned discussion to NEEDS_USER_DECISION and releases its lease', async () => {
    const storage = new Storage(':memory:');
    try {
      const discussion = storage.createDiscussion({
        topic: 'recovery',
        driver: 'claude',
        peer: 'codex',
        traceId: 'tr_recovery',
      });
      storage.updateDiscussionStatus(discussion.id, 'DISCUSSING');
      storage.acquireSessionLease({
        provider: 'codex',
        projectPath: discussion.projectPath,
        ownerId: discussion.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const recovered = storage.recoverStaleDiscussions(1_000);
      expect(recovered.map((item) => item.id)).toEqual([discussion.id]);
      expect(storage.getDiscussion(discussion.id)?.status).toBe('NEEDS_USER_DECISION');
      expect(() => storage.acquireSessionLease({
        provider: 'codex',
        projectPath: discussion.projectPath,
        ownerId: 'new-owner',
      })).not.toThrow();
    } finally {
      storage.close();
    }
  });
});
