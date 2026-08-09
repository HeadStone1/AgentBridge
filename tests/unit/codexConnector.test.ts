import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CodexConnector } from '../../packages/connectors/src/codex';

const fixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url)));

describe('CodexConnector', () => {
  it('starts and resumes one JSONL thread per discussion', async () => {
    const connector = new CodexConnector({
      command: process.execPath,
      extraArgs: [fixture],
      timeoutMs: 5_000,
    });

    expect(await connector.isAvailable()).toBe(true);

    const first = await connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'first',
      discussionId: 'dsc_codex_test',
    });
    expect(first.content).toBe('initial codex response');

    const second = await connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'second',
      discussionId: 'dsc_codex_test',
      providerSessionId: first.providerSessionId,
      providerSessionKind: first.providerSessionKind,
    });
    expect(second.content).toBe('resumed codex response');
    expect(second.providerSessionKind).toBe('codex-cli');
  });
});
