import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { ClaudeConnector, CodexAutoConnector, CodexConnector, discoverCodexCommands, type CodexBackendMode } from '@agentbridge/connectors';
import { Storage } from '@agentbridge/storage';
import { defaultGlobalCodexConfig } from './paths.js';
import { detectInstallation, readProjectRegistry, registryPath } from './installation.js';
import { inspectManagedSkills } from './skills.js';

export interface DoctorOptions {
  'codex-mode'?: string | boolean;
  'codex-app-command'?: string | boolean;
  'codex-command'?: string | boolean;
  'claude-config'?: string | boolean;
  'codex-config'?: string | boolean;
}

export async function runDoctor(
  projectPathValue: string,
  options: DoctorOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const projectPath = resolve(projectPathValue);
  const stateDir = join(projectPath, '.agentbridge');
  const projectFile = join(stateDir, 'project.json');
  const dbPath = resolve(env.AGENTBRIDGE_DB_PATH ?? join(stateDir, 'agentbridge.sqlite'));
  const claudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const codexConfig = String(options['codex-config'] ?? defaultGlobalCodexConfig());
  const recommendations: string[] = [];

  const project = inspectProject(projectPath, projectFile);
  if (!project.exists) recommendations.push(`Create the project directory first: ${projectPath}`);
  else if (!project.initialized) recommendations.push('No project state exists yet; it will be created automatically on the first AgentBridge tool call.');

  const installation = detectInstallation(env);
  if (!installation.valid) recommendations.push(...installation.issues.map((issue) => `Repair the AgentBridge installation: ${issue}`));
  if (!installation.sourceIndependent) recommendations.push('For a source-independent installation, use the GitHub Release package or global npm package.');

  const database = inspectDatabase(project.initialized, stateDir, dbPath);
  if (!database.ok) recommendations.push(`Check read/write permissions for ${projectPath}`);

  const configuration = {
    claude: inspectClaudeConfig(claudeConfig),
    codex: inspectCodexConfig(codexConfig),
  };
  if (!configuration.claude.ok) recommendations.push(`Run setup again to repair Claude MCP configuration: ${claudeConfig}`);
  if (!configuration.codex.ok) recommendations.push(`Run setup again to repair Codex MCP configuration: ${codexConfig}`);

  const providers = await inspectProviders(options, env);
  if (!providers.claudeCli) recommendations.push('Install/login to Claude Code or set AGENTBRIDGE_CLAUDE_COMMAND.');
  if (!providers.codexSelectedBackend) recommendations.push('Install/login to Codex App or Codex CLI, or pass an explicit Codex command.');
  const skills = inspectManagedSkills(env);
  if (!skills.ok) recommendations.push('Run setup again to install the AgentBridge collaboration skill for Claude and Codex.');

  const node = {
    ok: isSupportedNode(process.versions.node),
    version: process.versions.node,
    required: '>=22.13.0',
    bundled: installation.mode === 'release',
  };
  if (!node.ok) recommendations.push('Use Node.js 22.13 or newer, or install the self-contained GitHub Release package.');

  const registry = inspectRegistry(projectPath, env);
  if (project.initialized && !registry.registered) recommendations.push('Use an AgentBridge MCP tool once to add this existing project to automatic cleanup tracking.');

  const requiredChecks = [
    node.ok,
    project.exists,
    database.ok,
    installation.valid,
    registry.valid,
    configuration.claude.ok,
    configuration.codex.ok,
    providers.claudeCli,
    Boolean(providers.codexSelectedBackend),
    providers.modeError === null,
    skills.ok,
  ];
  const ok = requiredChecks.every(Boolean);
  return {
    ok,
    platform: { os: process.platform, arch: process.arch },
    node,
    installation,
    project,
    database,
    registry,
    configuration,
    providers,
    skills,
    summary: {
      passed: requiredChecks.filter(Boolean).length,
      failed: requiredChecks.filter((value) => !value).length,
      message: ok
        ? 'AgentBridge global checks passed. Restart both clients, open a project, and verify the MCP tools in each client.'
        : 'One or more local checks failed. Follow recommendations in order, then run doctor again.',
    },
    recommendations: [...new Set(recommendations)],
    limitation: 'doctor validates local files, configuration, database access, and provider executables; it cannot prove that an already-open client has reloaded MCP tools.',
  };
}

function inspectProject(projectPath: string, projectFile: string): Record<string, unknown> & { exists: boolean; initialized: boolean } {
  const exists = existsSync(projectPath) && safeIsDirectory(projectPath);
  const initialized = existsSync(projectFile);
  let metadataValid = false;
  let error: string | null = null;
  if (initialized) {
    try {
      const value = JSON.parse(readFileSync(projectFile, 'utf8')) as { rootPath?: unknown };
      metadataValid = typeof value.rootPath === 'string' && samePath(value.rootPath, projectPath);
      if (!metadataValid) error = 'project.json does not identify this project path';
    } catch (cause) {
      error = errorMessage(cause);
    }
  }
  return { path: projectPath, exists, initialized, metadataValid, projectFile, error };
}

function inspectDatabase(initialized: boolean, stateDir: string, dbPath: string): Record<string, unknown> & { ok: boolean } {
  if (!initialized) {
    try {
      accessSync(resolve(stateDir, '..'), constants.R_OK | constants.W_OK);
      return { ok: true, path: dbPath, exists: false, tested: false, autoInitialize: true };
    } catch (cause) {
      return { ok: false, path: dbPath, exists: false, tested: false, autoInitialize: true, error: errorMessage(cause) };
    }
  }
  try {
    accessSync(stateDir, constants.R_OK | constants.W_OK);
    const existed = existsSync(dbPath);
    const storage = new Storage(dbPath);
    try {
      storage.recoverExpiredSessionLeases();
    } finally {
      storage.close();
    }
    return { ok: true, path: dbPath, exists: existed || existsSync(dbPath), tested: true, readable: true, writable: true };
  } catch (cause) {
    return { ok: false, path: dbPath, exists: existsSync(dbPath), tested: true, error: errorMessage(cause) };
  }
}

function inspectClaudeConfig(path: string): Record<string, unknown> & { ok: boolean } {
  if (!existsSync(path)) return { ok: false, path, exists: false, configured: false, error: 'configuration file is missing' };
  try {
    const root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    const server = root.mcpServers?.agentbridge;
    if (!server || typeof server.command !== 'string') {
      return { ok: false, path, exists: true, configured: false, error: 'global agentbridge server is missing' };
    }
    const environmentMatches = server.env?.AGENTBRIDGE_AGENT === 'claude';
    const dynamicRouting = !server.env?.AGENTBRIDGE_PROJECT_PATH && !server.env?.AGENTBRIDGE_DB_PATH;
    const commandAvailable = isCommandAvailable(server.command);
    const entryAvailable = areEntryArgumentsAvailable(server.args);
    return {
      ok: environmentMatches && dynamicRouting && commandAvailable && entryAvailable,
      path,
      exists: true,
      configured: true,
      command: server.command,
      commandAvailable,
      entryAvailable,
      environmentMatches,
      dynamicRouting,
      scope: 'global',
    };
  } catch (cause) {
    return { ok: false, path, exists: true, configured: false, error: errorMessage(cause) };
  }
}

function inspectCodexConfig(path: string): Record<string, unknown> & { ok: boolean } {
  if (!existsSync(path)) return { ok: false, path, exists: false, configured: false, error: 'configuration file is missing' };
  try {
    const source = readFileSync(path, 'utf8');
    const section = extractTomlSection(source, 'mcp_servers.agentbridge');
    if (!section) return { ok: false, path, exists: true, configured: false, error: 'agentbridge section is missing' };
    const command = tomlValue(section, 'command');
    const args = tomlArray(section, 'args');
    const environmentMatches = /^\s*env\.AGENTBRIDGE_AGENT\s*=\s*(?:'codex'|"codex")\s*$/m.test(section);
    const dynamicRouting = !section.includes('env.AGENTBRIDGE_PROJECT_PATH')
      && !section.includes('env.AGENTBRIDGE_DB_PATH')
      && !/^\s*cwd\s*=/m.test(section);
    const commandAvailable = command ? isCommandAvailable(command) : false;
    const entryAvailable = areEntryArgumentsAvailable(args);
    return {
      ok: environmentMatches && dynamicRouting && commandAvailable && entryAvailable,
      path,
      exists: true,
      configured: true,
      command,
      commandAvailable,
      entryAvailable,
      environmentMatches,
      dynamicRouting,
      scope: 'global',
    };
  } catch (cause) {
    return { ok: false, path, exists: true, configured: false, error: errorMessage(cause) };
  }
}

async function inspectProviders(options: DoctorOptions, env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  let codexMode: CodexBackendMode = 'auto';
  let modeError: string | null = null;
  try {
    codexMode = parseCodexMode(String(options['codex-mode'] ?? env.AGENTBRIDGE_CODEX_MODE ?? 'auto'));
  } catch (cause) {
    modeError = errorMessage(cause);
  }
  const discoveryEnv = { ...env };
  if (typeof options['codex-app-command'] === 'string') discoveryEnv.AGENTBRIDGE_CODEX_APP_COMMAND = options['codex-app-command'];
  if (typeof options['codex-command'] === 'string') discoveryEnv.AGENTBRIDGE_CODEX_COMMAND = options['codex-command'];
  const codexAuto = new CodexAutoConnector({ mode: codexMode, candidates: discoverCodexCommands({ env: discoveryEnv }) });
  try {
    const [claudeCli, codexSelection, codexAppDetected] = await Promise.all([
      safely(() => new ClaudeConnector({ command: env.AGENTBRIDGE_CLAUDE_COMMAND }).isAvailable(), false),
      safely(() => codexAuto.getSelection(), null),
      isProcessRunning('codex'),
    ]);
    const codexCli = codexSelection
      ? await safely(() => new CodexConnector({ command: codexSelection.command }).isAvailable(), false)
      : false;
    return {
    claudeCli,
    codexCli,
    codexAppServer: codexSelection?.mode === 'app-server',
    codexSelectedBackend: codexSelection,
    codexCandidates: codexAuto.getCandidates().map(({ command, source, label, mode }) => ({ command, source, label, mode })),
    codexAppDetected,
    requestedMode: codexMode,
    modeError,
    availability: {
      claude: claudeCli ? 'BACKGROUND' : 'UNAVAILABLE',
      codex: codexSelection ? 'BACKGROUND' : 'UNAVAILABLE',
    },
    note: 'App Server is preferred. codexAppDetected is informational; AgentBridge capability-probes executables and does not attach to an open GUI process.',
    };
  } finally {
    await codexAuto.cancel('');
  }
}

function inspectRegistry(projectPath: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = registryPath(env);
  const projects = readProjectRegistry(env);
  let valid = true;
  let error: string | null = null;
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; projects?: unknown };
      valid = value.version === 1 && Array.isArray(value.projects);
      if (!valid) error = 'registry format is not supported';
    } catch (cause) {
      valid = false;
      error = errorMessage(cause);
    }
  }
  return {
    path,
    readable: true,
    valid,
    error,
    registered: projects.some((item) => samePath(item.projectPath, projectPath)),
    projectCount: projects.length,
  };
}

function isCommandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return existsSync(resolve(command));
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  return (env.PATH ?? '').split(delimiter).some((directory) => extensions.some((extension) => {
    const candidate = join(directory, process.platform === 'win32' && !command.toLowerCase().endsWith(extension.toLowerCase())
      ? `${command}${extension}`
      : command);
    return existsSync(candidate);
  }));
}

function extractTomlSection(source: string, name: string): string | null {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

function tomlValue(section: string, key: string): string | null {
  const match = section.match(new RegExp(
    `^\\s*${key}\\s*=\\s*(?:'((?:''|[^'])*)'|"((?:\\\\.|[^"\\\\])*)")\\s*$`,
    'm',
  ));
  if (!match) return null;
  return match[1] !== undefined ? match[1].replace(/''/g, "'") : decodeTomlBasicString(match[2]);
}

function tomlArray(section: string, key: string): string[] {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (!match) return [];
  return [...match[1].matchAll(/'((?:''|[^'])*)'|"((?:\\\\.|[^"\\\\])*)"/g)]
    .map((item) => item[1] !== undefined ? item[1].replace(/''/g, "'") : decodeTomlBasicString(item[2]));
}

function areEntryArgumentsAvailable(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const first = value[0];
  if (typeof first !== 'string' || first === 'mcp') return typeof first === 'string';
  const looksLikePath = isAbsolute(first) || first.includes('/') || first.includes('\\') || /\.[cm]?js$/i.test(first);
  return !looksLikePath || existsSync(resolve(first));
}

function tomlString(value: string): string {
  return value.replace(/'/g, "''");
}

function decodeTomlBasicString(value: string): string {
  return value.replace(/\\(\\|"|b|f|n|r|t)/g, (match, escape: string) => ({
    '\\\\': '\\',
    '\\"': '"',
    '\\b': '\b',
    '\\f': '\f',
    '\\n': '\n',
    '\\r': '\r',
    '\\t': '\t',
  }[match] ?? escape));
}

function safeIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isSupportedNode(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function parseCodexMode(value: string): CodexBackendMode {
  if (value === 'auto' || value === 'app-server' || value === 'cli') return value;
  throw new Error('--codex-mode must be auto, app-server, or cli');
}

async function safely<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try { return await operation(); } catch { return fallback; }
}

function isProcessRunning(processName: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'tasklist' : 'ps';
  const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='];
  return new Promise((done) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let output = '';
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 2_000);
    child.stdout?.on('data', (chunk: Buffer | string) => { output += chunk.toString(); });
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0 && output.toLowerCase().includes(processName.toLowerCase())));
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
