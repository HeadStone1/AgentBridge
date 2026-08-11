import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

export interface RegisteredProject {
  projectPath: string;
  claudeConfig: string;
  codexConfig: string;
  setupAt: string;
  scope?: 'project' | 'global';
}

interface ProjectRegistry {
  version: 1;
  projects: RegisteredProject[];
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function registryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENTBRIDGE_INSTALL_ROOT ?? join(homedir(), '.agentbridge'));
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(registryRoot(env), 'projects.json');
}

export function readProjectRegistry(env: NodeJS.ProcessEnv = process.env): RegisteredProject[] {
  const path = registryPath(env);
  if (!existsSync(path)) return [];
  let value: Partial<ProjectRegistry>;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectRegistry>;
  } catch (cause) {
    throw new Error(`Project registry is corrupt: ${path}`, { cause });
  }
  if (value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error(`Project registry has an invalid format: ${path}`);
  }
  if (value.projects.some((item) => !isRegisteredProject(item))) {
    throw new Error(`Project registry contains an invalid project entry: ${path}`);
  }
  return value.projects.map((item) => ({ ...item, projectPath: resolve(item.projectPath) }));
}

export function registerProject(
  registration: Omit<RegisteredProject, 'projectPath' | 'setupAt'> & { projectPath: string },
  env: NodeJS.ProcessEnv = process.env,
): RegisteredProject[] {
  return withRegistryLock(env, () => {
    const projectPath = resolve(registration.projectPath);
    const projects = readProjectRegistry(env).filter((item) => !samePath(item.projectPath, projectPath));
    projects.push({ ...registration, projectPath, setupAt: new Date().toISOString() });
    projects.sort((left, right) => left.projectPath.localeCompare(right.projectPath));
    writeRegistry(projects, env);
    return projects;
  });
}

export function unregisterProject(projectPath: string, env: NodeJS.ProcessEnv = process.env): RegisteredProject[] {
  return withRegistryLock(env, () => {
    const target = resolve(projectPath);
    const projects = readProjectRegistry(env).filter((item) => !samePath(item.projectPath, target));
    if (projects.length > 0) writeRegistry(projects, env);
    else if (existsSync(registryPath(env))) rmSync(registryPath(env), { force: true });
    return projects;
  });
}

export function ensureProjectMetadata(projectPathValue: string): Record<string, unknown> {
  const projectPath = resolve(projectPathValue);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }
  const stateDir = join(projectPath, '.agentbridge');
  const projectFile = join(stateDir, 'project.json');
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(projectFile)) {
    const value = {
      projectId: `prj_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: basename(projectPath),
      rootPath: projectPath,
      createdAt: new Date().toISOString(),
    };
    try {
      writeFileSync(projectFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (cause) {
      if (!existsSync(projectFile)) throw cause;
    }
  }
  return JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
}

function writeRegistry(projects: RegisteredProject[], env: NodeJS.ProcessEnv): void {
  const path = registryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const value: ProjectRegistry = { version: 1, projects };
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function isRegisteredProject(value: unknown): value is RegisteredProject {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RegisteredProject>;
  return typeof item.projectPath === 'string'
    && typeof item.claudeConfig === 'string'
    && typeof item.codexConfig === 'string'
    && typeof item.setupAt === 'string'
    && (item.scope === undefined || item.scope === 'project' || item.scope === 'global');
}

function withRegistryLock<T>(env: NodeJS.ProcessEnv, action: () => T): T {
  const path = registryPath(env);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw cause;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch { /* another process released the lock */ }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out locking project registry: ${path}`);
      Atomics.wait(WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
