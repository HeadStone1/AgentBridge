import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CodexAppServerConnector } from '../../packages/connectors/src/codexAppServer';

const fixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url)));

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
      });

      expect(first.message.content).toBe('app response 1');
      expect(second.message.content).toBe('app response 2');
      expect(second.providerSessionId).toBe(first.providerSessionId);
    } finally {
      await connector.cancel?.();
    }
  });
});
