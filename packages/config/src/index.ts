import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

export type DurationInput = string | number | null;
export type ConfigScope = 'global' | 'project';
export type ConfigSource = 'default' | 'global' | 'project' | 'environment';

export interface AgentBridgeConfigFile {
  version?: 1;
  invocation?: {
    autonomous?: boolean;
  };
  discussion?: {
    maxDuration?: DurationInput;
    idleTimeout?: DurationInput;
    startupTimeout?: DurationInput;
    stallGrace?: DurationInput;
    turnHardLimit?: DurationInput;
    leaseTimeout?: DurationInput;
    terminationGrace?: DurationInput;
    maxTurns?: number;
    maxTotalMessageChars?: number;
  };
  session?: {
    recoveryMaxAge?: DurationInput;
    pruneMaxAge?: DurationInput;
    retentionDays?: number;
    archiveOnClose?: boolean;
  };
}

export interface ResolvedAgentBridgeConfig {
  invocation: { autonomous: boolean };
  discussion: {
    maxDurationMs: number | null;
    idleTimeoutMs: number;
    startupTimeoutMs: number;
    stallGraceMs: number;
    turnHardLimitMs: number;
    leaseTimeoutMs: number;
    terminationGraceMs: number;
    maxTurns?: number;
    maxTotalMessageChars: number;
  };
  session: {
    recoveryMaxAgeMs?: number;
    pruneMaxAgeMs: number;
    retentionDays: number;
    archiveOnClose: boolean;
  };
}

export interface EffectiveConfig {
  config: ResolvedAgentBridgeConfig;
  globalPath: string;
  projectPath: string | null;
  globalExists: boolean;
  projectExists: boolean;
  sources: Record<string, ConfigSource>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_DURATION_MS = 365 * DAY_MS;
// Node's native timer delay overflows near 24.85 days. Keep watchdogs below
// that boundary; maxDuration can still be null for an unbounded discussion.
const MAX_TIMER_MS = 24 * DAY_MS;

export const DEFAULT_CONFIG_FILE: AgentBridgeConfigFile = {
  version: 1,
  invocation: { autonomous: true },
  discussion: {
    maxDuration: '30m',
    idleTimeout: '2m',
    startupTimeout: '15s',
    stallGrace: '3m',
    turnHardLimit: '30m',
    leaseTimeout: '2m',
    terminationGrace: '5s',
    maxTotalMessageChars: 500_000,
  },
  session: {
    pruneMaxAge: '30d',
    retentionDays: 0,
    archiveOnClose: false,
  },
};

const KNOWN_KEYS: Record<string, readonly string[]> = {
  root: ['version', 'invocation', 'discussion', 'session'],
  invocation: ['autonomous'],
  discussion: [
    'maxDuration', 'idleTimeout', 'startupTimeout', 'stallGrace', 'turnHardLimit',
    'leaseTimeout', 'terminationGrace', 'maxTurns', 'maxTotalMessageChars',
  ],
  session: ['recoveryMaxAge', 'pruneMaxAge', 'retentionDays', 'archiveOnClose'],
};

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENTBRIDGE_CONFIG_HOME ?? join(homedir(), '.agentbridge'));
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), 'config.json');
}

export function projectConfigPath(projectPath: string, env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return join(resolve(projectPath), '.agentbridge', 'config.json');
}

export function readConfigFile(path: string): AgentBridgeConfigFile {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`AgentBridge config is not valid JSON: ${path}`, { cause });
  }
  validateConfigFile(value, path);
  return value as AgentBridgeConfigFile;
}

export function resolveConfig(
  projectPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  const globalPath = globalConfigPath(env);
  const resolvedProjectPath = projectPath ? resolve(projectPath) : null;
  const projectPathValue = resolvedProjectPath ? projectConfigPath(resolvedProjectPath, env) : null;
  const globalExists = existsSync(globalPath);
  const projectExists = Boolean(projectPathValue && existsSync(projectPathValue));
  const global = globalExists ? readConfigFile(globalPath) : {};
  const project = projectPathValue && projectExists ? readConfigFile(projectPathValue) : {};
  const sources: Record<string, ConfigSource> = {
    version: 'default',
    'invocation.autonomous': 'default',
    'discussion.maxDuration': 'default',
    'discussion.idleTimeout': 'default',
    'discussion.startupTimeout': 'default',
    'discussion.stallGrace': 'default',
    'discussion.turnHardLimit': 'default',
    'discussion.leaseTimeout': 'default',
    'discussion.terminationGrace': 'default',
    'discussion.maxTotalMessageChars': 'default',
    'session.pruneMaxAge': 'default',
    'session.retentionDays': 'default',
    'session.archiveOnClose': 'default',
  };
  const merged = mergeConfig(cloneConfig(DEFAULT_CONFIG_FILE), global, 'global', sources);
  mergeConfig(merged, project, 'project', sources);
  applyEnvironmentOverrides(merged, env, sources);
  return {
    config: normalizeConfig(merged),
    globalPath,
    projectPath: projectPathValue,
    globalExists,
    projectExists,
    sources,
  };
}

export function writeConfig(scope: ConfigScope, value: AgentBridgeConfigFile, projectPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (scope === 'project' && !projectPath) throw new Error('A project path is required for project configuration');
  validateConfigFile(value, scope === 'global' ? globalConfigPath(env) : projectConfigPath(projectPath!, env));
  normalizeConfig(value);
  const path = scope === 'global' ? globalConfigPath(env) : projectConfigPath(projectPath!, env);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return path;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null) return 'unlimited';
  if (ms === undefined) return 'inherit';
  const units: Array<[number, string]> = [[DAY_MS, 'd'], [60 * 60 * 1_000, 'h'], [60 * 1_000, 'm'], [1_000, 's']];
  for (const [unit, label] of units) {
    if (ms % unit === 0) return `${ms / unit}${label}`;
  }
  return `${ms}ms`;
}

export function parseDuration(value: DurationInput, field: string, options: { allowUnlimited?: boolean; maxMs?: number } = {}): number | null {
  if (value === null) {
    if (options.allowUnlimited) return null;
    throw new Error(`${field} cannot be unlimited`);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`${field} must be an integer duration in milliseconds`);
    return validateDuration(value, field, options.maxMs ?? MAX_DURATION_MS);
  }
  const normalized = value.trim().toLowerCase();
  if (options.allowUnlimited && ['unlimited', 'none', 'off'].includes(normalized)) return null;
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(normalized);
  if (!match) throw new Error(`${field} must use a duration such as 30s, 10m, 2h, or 7d`);
  const amount = Number(match[1]);
  const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: DAY_MS };
  return validateDuration(amount * multipliers[match[2]], field, options.maxMs ?? MAX_DURATION_MS);
}

function validateDuration(value: number, field: string, maxMs: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maxMs) {
    throw new Error(`${field} must be between 1s and ${formatDuration(maxMs)}`);
  }
  return value;
}

function normalizeConfig(value: AgentBridgeConfigFile): ResolvedAgentBridgeConfig {
  const discussion = value.discussion ?? {};
  const session = value.session ?? {};
  return {
    invocation: { autonomous: value.invocation?.autonomous ?? true },
    discussion: {
      maxDurationMs: parseDuration(discussion.maxDuration === undefined ? '30m' : discussion.maxDuration, 'discussion.maxDuration', { allowUnlimited: true }),
      idleTimeoutMs: parseDuration(discussion.idleTimeout === undefined ? '2m' : discussion.idleTimeout, 'discussion.idleTimeout', { maxMs: MAX_TIMER_MS })!,
      startupTimeoutMs: parseDuration(discussion.startupTimeout === undefined ? '15s' : discussion.startupTimeout, 'discussion.startupTimeout', { maxMs: MAX_TIMER_MS })!,
      stallGraceMs: parseDuration(discussion.stallGrace === undefined ? '3m' : discussion.stallGrace, 'discussion.stallGrace', { maxMs: MAX_TIMER_MS })!,
      turnHardLimitMs: parseDuration(discussion.turnHardLimit === undefined ? '30m' : discussion.turnHardLimit, 'discussion.turnHardLimit', { maxMs: MAX_TIMER_MS })!,
      leaseTimeoutMs: parseDuration(discussion.leaseTimeout === undefined ? '2m' : discussion.leaseTimeout, 'discussion.leaseTimeout', { maxMs: MAX_TIMER_MS })!,
      terminationGraceMs: parseDuration(discussion.terminationGrace === undefined ? '5s' : discussion.terminationGrace, 'discussion.terminationGrace', { maxMs: 60_000 })!,
      ...(discussion.maxTurns === undefined ? {} : { maxTurns: assertInteger(discussion.maxTurns, 'discussion.maxTurns', 1, 50) }),
      maxTotalMessageChars: assertInteger(discussion.maxTotalMessageChars === undefined ? 500_000 : discussion.maxTotalMessageChars, 'discussion.maxTotalMessageChars', 1_000, 10_000_000),
    },
    session: {
      ...(session.recoveryMaxAge === undefined ? {} : { recoveryMaxAgeMs: parseDuration(session.recoveryMaxAge, 'session.recoveryMaxAge')! }),
      pruneMaxAgeMs: parseDuration(session.pruneMaxAge === undefined ? '30d' : session.pruneMaxAge, 'session.pruneMaxAge')!,
      retentionDays: assertInteger(session.retentionDays === undefined ? 0 : session.retentionDays, 'session.retentionDays', 0, 3_650),
      archiveOnClose: session.archiveOnClose === undefined ? false : session.archiveOnClose,
    },
  };
}

function assertInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function mergeConfig(target: AgentBridgeConfigFile, source: AgentBridgeConfigFile, sourceName: ConfigSource, sources: Record<string, ConfigSource>): AgentBridgeConfigFile {
  if (source.version !== undefined) {
    target.version = source.version;
    sources.version = sourceName;
  }
  if (source.invocation) {
    target.invocation = { ...(target.invocation ?? {}), ...source.invocation };
    if (source.invocation.autonomous !== undefined) sources['invocation.autonomous'] = sourceName;
  }
  if (source.discussion) {
    target.discussion = { ...(target.discussion ?? {}), ...source.discussion };
    for (const key of Object.keys(source.discussion)) sources[`discussion.${key}`] = sourceName;
  }
  if (source.session) {
    target.session = { ...(target.session ?? {}), ...source.session };
    for (const key of Object.keys(source.session)) sources[`session.${key}`] = sourceName;
  }
  return target;
}

function applyEnvironmentOverrides(config: AgentBridgeConfigFile, env: NodeJS.ProcessEnv, sources: Record<string, ConfigSource>): void {
  const durationMap: Array<[string, 'maxDuration' | 'idleTimeout' | 'startupTimeout' | 'stallGrace' | 'turnHardLimit' | 'leaseTimeout' | 'terminationGrace', boolean]> = [
    ['AGENTBRIDGE_MAX_DURATION_MS', 'maxDuration', true],
    ['AGENTBRIDGE_IDLE_TIMEOUT_MS', 'idleTimeout', false],
    ['AGENTBRIDGE_STARTUP_TIMEOUT_MS', 'startupTimeout', false],
    ['AGENTBRIDGE_STALL_GRACE_MS', 'stallGrace', false],
    ['AGENTBRIDGE_TURN_HARD_LIMIT_MS', 'turnHardLimit', false],
    ['AGENTBRIDGE_TIMEOUT_MS', 'leaseTimeout', false],
    ['AGENTBRIDGE_TERMINATION_GRACE_MS', 'terminationGrace', false],
  ];
  for (const [name, key, allowUnlimited] of durationMap) {
    const raw = env[name];
    if (!raw?.trim()) continue;
    const numeric = Number(raw.trim());
    config.discussion ??= {};
    config.discussion[key] = numeric === 0 && allowUnlimited ? null : numeric;
    sources[`discussion.${key}`] = 'environment';
  }
  if (env.AGENTBRIDGE_TIMEOUT_MS?.trim() && !env.AGENTBRIDGE_IDLE_TIMEOUT_MS?.trim()) {
    config.discussion ??= {};
    config.discussion.idleTimeout = Number(env.AGENTBRIDGE_TIMEOUT_MS);
    sources['discussion.idleTimeout'] = 'environment';
  }
  const boolean = env.AGENTBRIDGE_AUTONOMOUS_INVOCATION ?? env.AGENTBRIDGE_ALLOW_AUTONOMOUS;
  if (boolean?.trim()) {
    config.invocation ??= {};
    config.invocation.autonomous = parseBoolean(boolean, 'AGENTBRIDGE_AUTONOMOUS_INVOCATION');
    sources['invocation.autonomous'] = 'environment';
  }
  if (env.AGENTBRIDGE_MAX_TURNS?.trim()) {
    config.discussion ??= {};
    config.discussion.maxTurns = Number(env.AGENTBRIDGE_MAX_TURNS);
    sources['discussion.maxTurns'] = 'environment';
  }
  if (env.AGENTBRIDGE_DISCUSSION_RETENTION_DAYS?.trim()) {
    config.session ??= {};
    config.session.retentionDays = Number(env.AGENTBRIDGE_DISCUSSION_RETENTION_DAYS);
    sources['session.retentionDays'] = 'environment';
  }
  if (env.AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE?.trim()) {
    config.session ??= {};
    config.session.archiveOnClose = parseBoolean(env.AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE, 'AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE');
    sources['session.archiveOnClose'] = 'environment';
  }
  if (env.AGENTBRIDGE_RECOVERY_MAX_AGE_MS?.trim() && Number(env.AGENTBRIDGE_RECOVERY_MAX_AGE_MS) > 0) {
    config.session ??= {};
    config.session.recoveryMaxAge = Number(env.AGENTBRIDGE_RECOVERY_MAX_AGE_MS);
    sources['session.recoveryMaxAge'] = 'environment';
  }
  if (env.AGENTBRIDGE_SESSION_PRUNE_MAX_AGE_MS?.trim() && Number(env.AGENTBRIDGE_SESSION_PRUNE_MAX_AGE_MS) > 0) {
    config.session ??= {};
    config.session.pruneMaxAge = Number(env.AGENTBRIDGE_SESSION_PRUNE_MAX_AGE_MS);
    sources['session.pruneMaxAge'] = 'environment';
  }
}

function cloneConfig(value: AgentBridgeConfigFile): AgentBridgeConfigFile {
  return JSON.parse(JSON.stringify(value)) as AgentBridgeConfigFile;
}

function parseBoolean(value: string, field: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${field} must be a boolean value`);
}

function validateConfigFile(value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AgentBridge config must be a JSON object: ${path}`);
  const root = value as Record<string, unknown>;
  assertKnownKeys(root, KNOWN_KEYS.root, path, 'root');
  if (root.version !== undefined && root.version !== 1) throw new Error(`Unsupported AgentBridge config version in ${path}`);
  for (const [section, keys] of [['invocation', KNOWN_KEYS.invocation], ['discussion', KNOWN_KEYS.discussion], ['session', KNOWN_KEYS.session]] as const) {
    if (root[section] === undefined) continue;
    if (!root[section] || typeof root[section] !== 'object' || Array.isArray(root[section])) throw new Error(`${section} must be an object in ${path}`);
    assertKnownKeys(root[section] as Record<string, unknown>, keys, path, section);
  }
  const invocation = root.invocation as Record<string, unknown> | undefined;
  if (invocation?.autonomous !== undefined && typeof invocation.autonomous !== 'boolean') {
    throw new Error(`invocation.autonomous must be a boolean in ${path}`);
  }
  const discussion = root.discussion as Record<string, unknown> | undefined;
  for (const key of ['maxDuration', 'idleTimeout', 'startupTimeout', 'stallGrace', 'turnHardLimit', 'leaseTimeout', 'terminationGrace']) {
    const value = discussion?.[key];
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`discussion.${key} must be a duration string or milliseconds in ${path}`);
    }
  }
  for (const key of ['maxTurns', 'maxTotalMessageChars']) {
    if (discussion?.[key] !== undefined && typeof discussion[key] !== 'number') {
      throw new Error(`discussion.${key} must be a number in ${path}`);
    }
  }
  const session = root.session as Record<string, unknown> | undefined;
  for (const key of ['recoveryMaxAge', 'pruneMaxAge']) {
    const value = session?.[key];
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`session.${key} must be a duration string or milliseconds in ${path}`);
    }
  }
  if (session?.retentionDays !== undefined && typeof session.retentionDays !== 'number') {
    throw new Error(`session.retentionDays must be a number in ${path}`);
  }
  if (session?.archiveOnClose !== undefined && typeof session.archiveOnClose !== 'boolean') {
    throw new Error(`session.archiveOnClose must be a boolean in ${path}`);
  }
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], path: string, section: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown AgentBridge config key ${section}.${key} in ${path}`);
}
