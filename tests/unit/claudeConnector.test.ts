import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ClaudeConnector } from '../../packages/connectors/src/claude';

const fixture = resolve(fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url)));

describe('ClaudeConnector', () => {
  it('starts and resumes one CLI session per discussion', async () => {
    const connector = new ClaudeConnector({
      command: process.execPath,
      extraArgs: [fixture],
      timeoutMs: 5_000,
    });

    expect(await connector.isAvailable()).toBe(true);

    const first = await connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'first',
      discussionId: 'dsc_test',
    });
    expect(first.content).toBe('initial response');

    const second = await connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'second',
      discussionId: 'dsc_test',
      providerSessionId: first.providerSessionId,
      providerSessionKind: first.providerSessionKind,
    });
    expect(second.content).toBe('resumed response');
  });
});
