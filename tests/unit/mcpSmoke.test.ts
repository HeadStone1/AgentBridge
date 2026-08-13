import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMcpSmoke } from '../../packages/cli/src/mcpSmoke';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseEntry = resolve(repositoryRoot, 'release', 'agentbridge-mcp.mjs');
const releaseCliEntry = resolve(repositoryRoot, 'release', 'agentbridge-cli.mjs');

describe('release MCP SDK smoke stability', () => {
  it('starts the bundled CLI in ESM mode', () => {
    expect(existsSync(releaseCliEntry)).toBe(true);
    expect(execFileSync(process.execPath, [releaseCliEntry, 'version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()).toBe('0.7.3');
  });

  it('completes 30 consecutive SDK handshakes without timeout', async () => {
    expect(existsSync(releaseEntry)).toBe(true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await runMcpSmoke(releaseEntry, repositoryRoot, 15_000);
      expect(result, `attempt ${attempt + 1}`).toMatchObject({ status: 'PASS' });
      expect(result.tools).toHaveLength(8);
    }
  }, 120_000);
});
