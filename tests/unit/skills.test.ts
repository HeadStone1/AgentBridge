import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectManagedSkills, installManagedSkills, removeManagedSkills } from '../../packages/cli/src/skills';

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('managed collaboration skill', () => {
  it('installs, detects modification, and preserves modified copies', () => {
    const root = temporaryDirectory();
    const env = {
      AGENTBRIDGE_INSTALL_ROOT: join(root, 'registry'),
      AGENTBRIDGE_SKILL_HOME: join(root, 'home'),
      AGENTBRIDGE_SKILL_SOURCE: join(repositoryRoot, 'skills', 'agentbridge-collaboration'),
    };
    const installed = installManagedSkills('0.7.0', env);
    expect((installed.targets as any[]).every((target) => target.installed)).toBe(true);
    expect(inspectManagedSkills(env).ok).toBe(true);

    const claudeSkill = join(env.AGENTBRIDGE_SKILL_HOME, '.claude', 'skills', 'agentbridge-collaboration', 'SKILL.md');
    writeFileSync(claudeSkill, `${readFileSync(claudeSkill, 'utf8')}\ncustom edit\n`);
    expect(inspectManagedSkills(env).targets[0]).toMatchObject({ modified: true });
    const removed = removeManagedSkills(env);
    expect((removed.targets as any[])[0]).toMatchObject({ removed: false, reason: 'modified skill preserved' });
    expect(existsSync(claudeSkill)).toBe(true);
  });

  it('does not overwrite a pre-existing custom skill', () => {
    const root = temporaryDirectory();
    const home = join(root, 'home');
    const custom = join(home, '.agents', 'skills', 'agentbridge-collaboration');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'SKILL.md'), 'custom');
    const result = installManagedSkills('0.7.0', {
      AGENTBRIDGE_INSTALL_ROOT: join(root, 'registry'),
      AGENTBRIDGE_SKILL_HOME: home,
      AGENTBRIDGE_SKILL_SOURCE: join(repositoryRoot, 'skills', 'agentbridge-collaboration'),
    });
    expect((result.targets as any[]).find((target) => target.path === custom)).toMatchObject({ conflict: true });
    expect(readFileSync(join(custom, 'SKILL.md'), 'utf8')).toBe('custom');
  });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'agentbridge-skill-test-'));
  temporaryDirectories.push(path);
  return path;
}
