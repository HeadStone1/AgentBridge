import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CodexAutoConnector,
  discoverCodexCommands,
  type CodexCommandCandidate,
} from '../../packages/connectors/src/index';

const appServerFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url)));
const cliFixture = resolve(fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url)));

describe('Codex GUI-first backend selection', () => {
  it('discovers the executable bundled with Codex Desktop on Windows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-codex-desktop-'));
    const executable = join(directory, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    mkdirSync(resolve(executable, '..'), { recursive: true });
    writeFileSync(executable, 'fixture');
    writeFileSync(join(resolve(executable, '..'), 'codex-26.1.0.exe'), 'versioned fixture');
    writeFileSync(join(resolve(executable, '..'), 'codex-command-runner.exe'), 'unrelated helper');
    try {
      const candidates = discoverCodexCommands({
        platform: 'win32',
        env: { LOCALAPPDATA: directory },
        homeDirectory: directory,
      });
      expect(candidates[0]).toMatchObject({
        command: executable,
        source: 'desktop',
        mode: 'auto',
      });
      expect(candidates.some((candidate) => candidate.command.endsWith('codex-26.1.0.exe'))).toBe(true);
      expect(candidates.some((candidate) => candidate.command.endsWith('codex-command-runner.exe'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers App Server when the discovered executable supports it', async () => {
    const connector = fixtureConnector(appServerFixture);
    try {
      expect(await connector.getSelection()).toMatchObject({ mode: 'app-server', source: 'desktop' });
      const response = await connector.sendAndWait({
        projectPath: process.cwd(),
        prompt: 'hello',
        discussionId: 'dsc_auto_app_server',
      });
      expect(response.content).toBe('app response 1');
    } finally {
      await connector.cancel('dsc_auto_app_server');
    }
  });

  it('falls back to codex exec when App Server is unavailable', async () => {
    const connector = fixtureConnector(cliFixture);
    expect(await connector.getSelection()).toMatchObject({ mode: 'cli', source: 'desktop' });
    const response = await connector.sendAndWait({
      projectPath: process.cwd(),
      prompt: 'hello',
      discussionId: 'dsc_auto_cli',
    });
    expect(response.content).toBe('initial codex response');
  });
});

function fixtureConnector(fixture: string): CodexAutoConnector {
  const candidates: CodexCommandCandidate[] = [{
    command: process.execPath,
    source: 'desktop',
    label: 'fixture',
    mode: 'auto',
    args: [fixture],
  }];
  return new CodexAutoConnector({ candidates, timeoutMs: 5_000 });
}
