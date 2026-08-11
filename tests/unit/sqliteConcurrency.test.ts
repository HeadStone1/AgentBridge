import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { Storage } from '@agentbridge/storage';

describe('SQLite dual-process safety', () => {
  it('waits for a startup write lock before enabling WAL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-startup-lock-'));
    const dbPath = join(directory, 'shared.sqlite');
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('CREATE TABLE lock_probe (value INTEGER); BEGIN IMMEDIATE; INSERT INTO lock_probe VALUES (1);');
      parentPort.postMessage('locked');
      setTimeout(() => {
        db.exec('COMMIT');
        db.close();
        parentPort.postMessage('released');
      }, 250);
    `, { eval: true, workerData: dbPath });
    let storage: Storage | undefined;

    try {
      await waitForWorkerMessage(worker, 'locked');
      const released = waitForWorkerMessage(worker, 'released');
      storage = new Storage(dbPath);
      await released;
      expect(storage.listDiscussions()).toEqual([]);
    } finally {
      storage?.close();
      await worker.terminate();
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

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

      first.acquireDiscussionLease({
        discussionId: discussion.id,
        projectPath: directory,
        ownerId: 'owner-a',
      });
      expect(() => second.acquireDiscussionLease({
        discussionId: discussion.id,
        projectPath: directory,
        ownerId: 'owner-b',
      })).toThrow('already being operated on');
      expect(second.renewDiscussionLease(discussion.id, 'owner-a', 5_000)).toBe(true);
      second.releaseDiscussionLease(discussion.id, 'owner-a');
      expect(first.hasDiscussionLease(discussion.id)).toBe(false);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('serializes competing discussion lease acquisitions across connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-discussion-lease-'));
    const dbPath = join(directory, 'shared.sqlite');
    const first = new Storage(dbPath);
    const second = new Storage(dbPath);
    try {
      const discussion = first.createDiscussion({
        topic: 'concurrent lease',
        driver: 'claude',
        peer: 'codex',
        projectPath: directory,
        traceId: 'tr_concurrent_lease',
      });

      const results = await Promise.allSettled([
        Promise.resolve().then(() => first.acquireDiscussionLease({
          discussionId: discussion.id,
          projectPath: directory,
          ownerId: 'owner-a',
        })),
        Promise.resolve().then(() => second.acquireDiscussionLease({
          discussionId: discussion.id,
          projectPath: directory,
          ownerId: 'owner-b',
        })),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

function waitForWorkerMessage(worker: Worker, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message !== expected) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}
