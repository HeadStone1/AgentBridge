import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  checkForUpdate,
  compareVersions,
  normalizeVersion,
  releaseAssetName,
  rollbackInstalledRelease,
} from '../../packages/cli/src/releaseManager.js';

describe('Release management', () => {
  it('reads the workspace release version during development', () => {
    expect(CURRENT_VERSION).toBe('0.5.0');
  });

  it('normalizes and compares stable and prerelease versions', () => {
    expect(normalizeVersion('v1.2.3+build.4')).toBe('1.2.3');
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.2.3-beta.2', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3-beta.10', '1.2.3-beta.2')).toBe(1);
  });

  it('uses deterministic platform release asset names', () => {
    expect(releaseAssetName('v0.4.0', 'win32', 'x64')).toBe('AgentBridge-v0.4.0-win32-x64.zip');
    expect(releaseAssetName('0.4.0', 'linux', 'arm64')).toBe('AgentBridge-v0.4.0-linux-arm64.tar.gz');
  });

  it('reads the stable GitHub release metadata without installing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      tag_name: 'v9.0.0',
      prerelease: false,
      draft: false,
      html_url: 'https://example.test/release',
      assets: [],
    }), { status: 200 }) as Promise<Response>;
    const result = await checkForUpdate({ fetchImpl, repository: 'example/project' });
    expect(result.info.latestVersion).toBe('9.0.0');
    expect(result.info.updateAvailable).toBe(true);
    expect(result.info.repository).toBe('example/project');
  });

  it('treats a missing stable Release as an empty update channel', async () => {
    const fetchImpl = async () => new Response('', { status: 404 }) as Promise<Response>;
    const result = await checkForUpdate({ fetchImpl, repository: 'example/project' });
    expect(result.release).toBeNull();
    expect(result.info.updateAvailable).toBe(false);
    expect(result.info.message).toContain('No published stable Release');
  });

  it('rolls back by switching only the current version pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbridge-release-'));
    try {
      mkdirSync(join(root, 'versions', '0.3.0'), { recursive: true });
      mkdirSync(join(root, 'versions', '0.4.0'), { recursive: true });
      writeFileSync(join(root, 'current'), '0.4.0\n');
      const result = rollbackInstalledRelease(root);
      expect(result.currentVersion).toBe('0.3.0');
      expect(readFileSync(join(root, 'current'), 'utf8').trim()).toBe('0.3.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
