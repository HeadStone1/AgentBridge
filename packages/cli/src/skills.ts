import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { registryRoot } from '@agentbridge/storage';

const SKILL_NAME = 'agentbridge-collaboration';

interface ManagedSkillTarget { path: string; hash: string; version: string }
interface ManagedSkillManifest { version: 1; targets: ManagedSkillTarget[] }

export function installManagedSkills(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = skillHome(env),
): Record<string, unknown> {
  const source = findSkillSource(env);
  const sourceHash = hashDirectory(source);
  const manifest = readManifest(env);
  const targets = skillTargets(env, homeDirectory);
  const results = targets.map((target) => {
    const previous = manifest.targets.find((item) => samePath(item.path, target));
    if (existsSync(target)) {
      const existingHash = hashDirectory(target);
      if (!previous || previous.hash !== existingHash) {
        return { path: target, installed: false, conflict: true, reason: 'existing skill is not an unmodified AgentBridge-managed copy' };
      }
      rmSync(target, { recursive: true, force: true });
    }
    copyDirectory(source, target);
    return { path: target, installed: true, conflict: false, hash: sourceHash, version };
  });
  manifest.targets = [
    ...manifest.targets.filter((item) => !targets.some((target) => samePath(item.path, target))),
    ...results.filter((item) => item.installed).map((item) => ({ path: item.path, hash: sourceHash, version })),
  ];
  writeManifest(manifest, env);
  return { source, sourceHash, targets: results };
}

export function removeManagedSkills(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const manifest = readManifest(env);
  const results = manifest.targets.map((target) => {
    if (!existsSync(target.path)) return { path: target.path, removed: false, reason: 'missing' };
    if (hashDirectory(target.path) !== target.hash) {
      return { path: target.path, removed: false, reason: 'modified skill preserved' };
    }
    rmSync(target.path, { recursive: true, force: true });
    return { path: target.path, removed: true };
  });
  manifest.targets = manifest.targets.filter((target) => existsSync(target.path));
  writeManifest(manifest, env);
  return { targets: results };
}

export function inspectManagedSkills(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = skillHome(env),
): { ok: boolean; targets: Record<string, unknown>[] } {
  const manifest = readManifest(env);
  const targets = skillTargets(env, homeDirectory).map((path) => {
    const managed = manifest.targets.find((item) => samePath(item.path, path));
    const exists = existsSync(path);
    const hash = exists ? hashDirectory(path) : null;
    return {
      path,
      exists,
      managed: Boolean(managed),
      custom: exists && !managed,
      modified: Boolean(managed && hash !== managed.hash),
      version: managed?.version ?? null,
    };
  });
  return { ok: targets.every((target) => target.exists), targets };
}

function findSkillSource(env: NodeJS.ProcessEnv): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AGENTBRIDGE_SKILL_SOURCE,
    join(moduleDirectory, '..', 'skills', SKILL_NAME),
    join(moduleDirectory, '..', '..', '..', 'skills', SKILL_NAME),
  ].filter((value): value is string => Boolean(value));
  const source = candidates.map((candidate) => resolve(candidate)).find((path) => existsSync(join(path, 'SKILL.md')));
  if (!source) throw new Error(`Bundled ${SKILL_NAME} skill was not found`);
  return source;
}

function skillTargets(env: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const claudeRoot = resolve(env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'));
  const agentsRoot = resolve(env.AGENTBRIDGE_AGENTS_DIR ?? join(homeDirectory, '.agents'));
  return [join(claudeRoot, 'skills', SKILL_NAME), join(agentsRoot, 'skills', SKILL_NAME)];
}

function skillHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.AGENTBRIDGE_SKILL_HOME ?? env.HOME ?? env.USERPROFILE ?? homedir());
}

function manifestPath(env: NodeJS.ProcessEnv): string {
  return join(registryRoot(env), 'managed-skills.json');
}

function readManifest(env: NodeJS.ProcessEnv): ManagedSkillManifest {
  const path = manifestPath(env);
  if (!existsSync(path)) return { version: 1, targets: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ManagedSkillManifest;
    return value.version === 1 && Array.isArray(value.targets) ? value : { version: 1, targets: [] };
  } catch {
    return { version: 1, targets: [] };
  }
}

function writeManifest(manifest: ManagedSkillManifest, env: NodeJS.ProcessEnv): void {
  const path = manifestPath(env);
  if (manifest.targets.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function hashDirectory(path: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative(path, absolute).replace(/\\/g, '/'));
        hash.update(readFileSync(absolute));
      }
    }
  };
  if (!existsSync(path) || !statSync(path).isDirectory()) return '';
  visit(path);
  return hash.digest('hex');
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
