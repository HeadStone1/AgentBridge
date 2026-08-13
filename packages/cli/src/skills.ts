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

const CORE_SKILL_NAME = 'agentbridge-collaboration';
const SKILL_PREFIX = 'agentbridge-';

interface ManagedSkillTarget { path: string; hash: string; version: string }
interface ManagedSkillManifest { version: 1; targets: ManagedSkillTarget[] }
interface SkillSource { name: string; path: string; hash: string }

export function installManagedSkills(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = skillHome(env),
): Record<string, unknown> {
  const sourceRoot = findSkillSourceRoot(env);
  const sources = discoverSkillSources(sourceRoot);
  const manifest = readManifest(env);
  const targets = skillTargets(sources, env, homeDirectory);
  const results = targets.map(({ source, target }) => {
    const previous = manifest.targets.find((item) => samePath(item.path, target));
    if (existsSync(target)) {
      const existingHash = hashDirectory(target);
      if (!previous || previous.hash !== existingHash) {
        return {
          skill: source.name,
          path: target,
          installed: false,
          conflict: true,
          reason: 'existing skill is not an unmodified AgentBridge-managed copy',
        };
      }
      rmSync(target, { recursive: true, force: true });
    }
    copyDirectory(source.path, target);
    return { skill: source.name, path: target, installed: true, conflict: false, hash: source.hash, version };
  });
  const targetPaths = targets.map((item) => item.target);
  manifest.targets = [
    ...manifest.targets.filter((item) => !targetPaths.some((target) => samePath(item.path, target))),
    ...results.filter((item) => item.installed).map((item) => ({ path: item.path, hash: item.hash!, version })),
  ];
  writeManifest(manifest, env);
  return {
    source: sourceRoot,
    skills: sources.map((source) => ({ name: source.name, hash: source.hash })),
    targets: results,
  };
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
  const sources = discoverSkillSources(findSkillSourceRoot(env));
  const manifest = readManifest(env);
  const targets = skillTargets(sources, env, homeDirectory).map(({ source, target: path }) => {
    const managed = manifest.targets.find((item) => samePath(item.path, path));
    const exists = existsSync(path);
    const hash = exists ? hashDirectory(path) : null;
    return {
      path,
      skill: source.name,
      exists,
      managed: Boolean(managed),
      custom: exists && !managed,
      modified: Boolean(managed && hash !== managed.hash),
      version: managed?.version ?? null,
    };
  });
  return { ok: targets.every((target) => target.exists), targets };
}

function findSkillSourceRoot(env: NodeJS.ProcessEnv): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AGENTBRIDGE_SKILL_SOURCE,
    join(moduleDirectory, '..', 'skills'),
    join(moduleDirectory, '..', '..', '..', 'skills'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates.map((value) => resolve(value))) {
    const root = existsSync(join(candidate, 'SKILL.md')) ? dirname(candidate) : candidate;
    if (existsSync(join(root, CORE_SKILL_NAME, 'SKILL.md'))) return root;
  }
  throw new Error(`Bundled ${CORE_SKILL_NAME} skill was not found`);
}

function discoverSkillSources(root: string): SkillSource[] {
  const sources = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .filter((entry) => existsSync(join(entry.path, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ ...entry, hash: hashDirectory(entry.path) }));
  if (!sources.some((source) => source.name === CORE_SKILL_NAME)) {
    throw new Error(`Bundled ${CORE_SKILL_NAME} skill was not found`);
  }
  return sources;
}

function skillTargets(
  sources: SkillSource[],
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): Array<{ source: SkillSource; target: string }> {
  const claudeRoot = resolve(env.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'));
  const agentsRoot = resolve(env.AGENTBRIDGE_AGENTS_DIR ?? join(homeDirectory, '.agents'));
  return sources.flatMap((source) => [
    { source, target: join(claudeRoot, 'skills', source.name) },
    { source, target: join(agentsRoot, 'skills', source.name) },
  ]);
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
