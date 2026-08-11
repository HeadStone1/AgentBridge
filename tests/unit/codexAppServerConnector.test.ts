import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CodexAppServerConnector } from '../../packages/connectors/src/codexAppServer';

const fixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url)));
const failureFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server-failure.mjs', import.meta.url)));
const missingStatusFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server-missing-status.mjs', import.meta.url)));
const postTurnFailureFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server-post-turn-failure.mjs', import.meta.url)));

describe('CodexAppServerConnector', () => {
  it('starts one App Server and resumes its thread', async () => {
    const connector = new CodexAppServerConnector({
      command: process.execPath,
      serverArgs: [fixture],
      timeoutMs: 5_000,
    });

    try {
      expect(await connector.isAvailable()).toBe(true);
      const first = await connector.sendAndWait({
        projectPath: process.cwd(),
        prompt: 'first',
        discussionId: 'dsc_app_server_test',
      });
      const second = await connector.sendAndWait({
        projectPath: process.cwd(),
        prompt: 'second',
        discussionId: 'dsc_app_server_test',
        providerSessionId: first.providerSessionId,
        providerSessionKind: first.providerSessionKind,
      });

      expect(first.content).toBe('app response 1');
      expect(second.content).toBe('app response 2');
      expect(second.providerSessionId).toBe(first.providerSessionId);
    } finally {
      await connector.cancel?.();
    }
  });

  it('rejects a completed turn whose provider status is failed', async () => {
    const connector = new CodexAppServerConnector({
      command: process.execPath,
      serverArgs: [failureFixture],
      timeoutMs: 5_000,
    });

    await expect(connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'fail',
      discussionId: 'dsc_app_server_failure',
    })).rejects.toMatchObject({
      code: 'FAILED',
      message: expect.stringContaining('simulated provider diagnostic'),
    });
    await connector.cancel?.();
  });

  it('rejects a completed turn without an explicit provider status', async () => {
    const connector = new CodexAppServerConnector({
      command: process.execPath,
      serverArgs: [missingStatusFixture],
      timeoutMs: 5_000,
    });

    await expect(connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'missing status',
      discussionId: 'dsc_app_server_missing_status',
    })).rejects.toMatchObject({ code: 'PROTOCOL' });
    await connector.cancel?.();
  });

  it('marks failures after turn/start as ambiguous', async () => {
    const connector = new CodexAppServerConnector({
      command: process.execPath,
      serverArgs: [postTurnFailureFixture],
      timeoutMs: 5_000,
    });

    await expect(connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'may have started',
      discussionId: 'dsc_post_turn_failure',
    })).rejects.toMatchObject({ code: 'FAILED', ambiguous: true });
    await connector.cancel?.();
  });
});
