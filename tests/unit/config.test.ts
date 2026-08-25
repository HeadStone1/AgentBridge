import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globalConfigPath,
  projectConfigPath,
  readConfigFile,
  resolveConfig,
  writeConfig,
} from '../../packages/config/src/index';

describe('AgentBridge configuration', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('merges project overrides over global defaults without mutating defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    roots.push(root);
    const project = join(root, 'project');
    const env = { AGENTBRIDGE_CONFIG_HOME: join(root, 'global') };
    writeConfig('global', {
      version: 1,
      invocation: { autonomous: true },
      discussion: { maxDuration: '2h', idleTimeout: '10m' },
    }, undefined, env);
    writeConfig('project', {
      version: 1,
      invocation: { autonomous: false },
      discussion: { maxDuration: '12h' },
    }, project, env);

    const effective = resolveConfig(project, env);
    expect(effective.config.invocation.autonomous).toBe(false);
    expect(effective.config.discussion.maxDurationMs).toBe(12 * 60 * 60 * 1_000);
    expect(effective.config.discussion.idleTimeoutMs).toBe(10 * 60 * 1_000);
    expect(effective.sources['invocation.autonomous']).toBe('project');

    const globalOnly = resolveConfig(undefined, { AGENTBRIDGE_CONFIG_HOME: join(root, 'missing') });
    expect(globalOnly.config.invocation.autonomous).toBe(true);
  });

  it('supports unlimited max duration and retains atomic backups', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    roots.push(root);
    const env = { AGENTBRIDGE_CONFIG_HOME: root };
    writeConfig('global', { version: 1, discussion: { maxDuration: null } }, undefined, env);
    writeConfig('global', { version: 1, discussion: { maxDuration: '1d' } }, undefined, env);
    expect(existsSync(`${globalConfigPath(env)}.bak`)).toBe(true);
    expect(readConfigFile(globalConfigPath(env)).discussion?.maxDuration).toBe('1d');
    expect(resolveConfig(undefined, env).config.discussion.maxDurationMs).toBe(24 * 60 * 60 * 1_000);
  });

  it('keeps legacy environment variables as an explicit override', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    roots.push(root);
    const project = join(root, 'project');
    const env = {
      AGENTBRIDGE_CONFIG_HOME: join(root, 'global'),
      AGENTBRIDGE_MAX_DURATION_MS: '0',
      AGENTBRIDGE_AUTONOMOUS_INVOCATION: 'false',
    };
    const effective = resolveConfig(project, env);
    expect(effective.config.discussion.maxDurationMs).toBeNull();
    expect(effective.config.invocation.autonomous).toBe(false);
    expect(effective.sources['invocation.autonomous']).toBe('environment');
  });

  it('rejects unknown keys instead of silently ignoring typos', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    roots.push(root);
    const env = { AGENTBRIDGE_CONFIG_HOME: root };
    writeConfig('global', { version: 1, discussion: { maxDuration: '1h' } }, undefined, env);
    const path = globalConfigPath(env);
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    original.discussion = { ...(original.discussion as object), maxDuraton: '2h' };
    writeFileSync(path, JSON.stringify(original));
    expect(() => resolveConfig(undefined, env)).toThrow('Unknown AgentBridge config key');
  });

  it('uses the project-local config path beneath .agentbridge', () => {
    expect(projectConfigPath('C:/work/example')).toMatch(/\.agentbridge[\\/]config\.json$/);
  });
});
