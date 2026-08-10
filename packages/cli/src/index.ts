#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import {
  type CodexBackendMode,
} from '@agentbridge/connectors';
import { AuditService } from '@agentbridge/audit';
import { Storage } from '@agentbridge/storage';
import type { AgentType, SessionStatus } from '@agentbridge/protocol';
import {
  configureClaudeJson,
  configureCodexToml,
  listClaudeAgentBridgeProjects,
  removeClaudeJson,
  removeCodexToml,
} from './mcpConfig.js';
import { defaultCodexConfig, resolveMcpEntry } from './paths.js';
import { runDoctor } from './diagnostics.js';
import {
  cleanupEmptyRegistryRoot,
  detectInstallation,
  readProjectRegistry,
  registerProject,
  registryRoot,
  scheduleProgramRemoval,
  unregisterProject,
  type RegisteredProject,
} from './installation.js';
import {
  CURRENT_VERSION,
  checkForUpdate,
  installUpdate,
  rollbackInstalledRelease,
} from './releaseManager.js';

type Options = Record<string, string | boolean>;

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'help';
  const { options, positional } = parseArgs(argv.slice(1));
  const projectPath = resolve(String(options['project-path'] ?? positional[0] ?? process.cwd()));

  switch (command) {
    case 'help':
      printHelp();
      return;
    case 'init':
      console.log(JSON.stringify(initProject(projectPath), null, 2));
      return;
    case 'setup':
      console.log(JSON.stringify(setupProject(projectPath, options), null, 2));
      return;
    case 'register-session':
      console.log(JSON.stringify(registerSession(options, projectPath), null, 2));
      return;
    case 'status':
      console.log(JSON.stringify(status(projectPath), null, 2));
      return;
    case 'doctor':
      console.log(JSON.stringify(await runDoctor(projectPath, options), null, 2));
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(CURRENT_VERSION);
      return;
    case 'update':
      console.log(JSON.stringify(await update(options), null, 2));
      return;
    case 'rollback':
      console.log(JSON.stringify(rollbackInstalledRelease(), null, 2));
      return;
    case 'uninstall':
      console.log(JSON.stringify(uninstallProject(projectPath, options.yes === true, options), null, 2));
      return;
    case 'uninstall-all':
      console.log(JSON.stringify(uninstallAll(options.yes === true, options), null, 2));
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run: agentbridge help`);
  }
}

function initProject(projectPath: string): Record<string, unknown> {
  const stateDir = join(projectPath, '.agentbridge');
  const projectFile = join(stateDir, 'project.json');
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(projectFile)) {
    writeFileSync(projectFile, JSON.stringify({
      projectId: `prj_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: basename(projectPath),
      rootPath: projectPath,
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  return JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
}

function setupProject(projectPath: string, options: Options): Record<string, unknown> {
  const project = initProject(projectPath);
  const claudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const codexConfig = String(options['codex-config'] ?? defaultCodexConfig(projectPath));
  if (options['no-config'] === true) {
    const projects = registerProject({ projectPath, claudeConfig, codexConfig });
    return { project, configured: [], registeredProjects: projects.length };
  }

  const releaseLauncher = process.env.AGENTBRIDGE_LAUNCHER;
  const mcpCommand = String(options['mcp-command'] ?? releaseLauncher ?? process.execPath);
  const mcpEntry = String(options['mcp-entry'] ?? defaultMcpEntry());
  const sharedEnv: Record<string, string> = {
    AGENTBRIDGE_DB_PATH: join(projectPath, '.agentbridge', 'agentbridge.sqlite'),
    AGENTBRIDGE_PROJECT_PATH: projectPath,
  };
  if (typeof options['codex-app-command'] === 'string') {
    sharedEnv.AGENTBRIDGE_CODEX_APP_COMMAND = options['codex-app-command'];
  }
  if (typeof options['codex-command'] === 'string') {
    sharedEnv.AGENTBRIDGE_CODEX_COMMAND = options['codex-command'];
  }
  if (typeof options['codex-mode'] === 'string') {
    sharedEnv.AGENTBRIDGE_CODEX_MODE = parseCodexMode(options['codex-mode']);
  }
  const args = releaseLauncher && mcpCommand === releaseLauncher
    ? ['mcp']
    : mcpCommand === process.execPath ? [mcpEntry] : [];
  const claudeServer = {
    command: mcpCommand,
    args,
    env: { ...sharedEnv, AGENTBRIDGE_AGENT: 'claude' },
  };
  const codexServer = {
    command: mcpCommand,
    args,
    env: { ...sharedEnv, AGENTBRIDGE_AGENT: 'codex' },
    cwd: projectPath,
  };
  const configured = [
    configureClaudeJson(claudeConfig, claudeServer, projectPath),
    configureCodexToml(codexConfig, codexServer),
  ];
  const projects = registerProject({ projectPath, claudeConfig, codexConfig });
  return {
    project,
    codexBackend: {
      strategy: sharedEnv.AGENTBRIDGE_CODEX_MODE ?? 'auto',
      appServerFirst: (sharedEnv.AGENTBRIDGE_CODEX_MODE ?? 'auto') !== 'cli',
      automaticDesktopDiscovery: !sharedEnv.AGENTBRIDGE_CODEX_APP_COMMAND && !sharedEnv.AGENTBRIDGE_CODEX_COMMAND,
    },
    configured,
    registeredProjects: projects.length,
  };
}

function defaultMcpEntry(): string {
  return resolveMcpEntry(process.argv[1]);
}

function registerSession(options: Options, projectPath: string): unknown {
  const provider = String(options.provider ?? '');
  const sessionId = String(options['session-id'] ?? '');
  if (provider !== 'claude' && provider !== 'codex') throw new Error('--provider must be claude or codex');
  if (!sessionId) throw new Error('--session-id is required');
  const status = String(options.status ?? 'UNKNOWN') as SessionStatus;
  if (!['IDLE', 'BUSY', 'BRIDGE_OWNED', 'UNKNOWN'].includes(status)) {
    throw new Error('--status must be IDLE, BUSY, BRIDGE_OWNED, or UNKNOWN');
  }
  const metadataValue = options.metadata;
  const metadata = typeof metadataValue === 'string' ? JSON.parse(metadataValue) as Record<string, unknown> : {};
  const storage = openStorage(projectPath);
  try {
    return storage.registerSession({ provider: provider as AgentType, sessionId, projectPath, status, metadata });
  } finally {
    storage.close();
  }
}

function status(projectPath: string): Record<string, unknown> {
  const storage = openStorage(projectPath);
  try {
    const audit = new AuditService(storage);
    return {
      projectPath,
      project: readProject(projectPath),
      sessions: storage.listSessions(projectPath),
      discussions: storage.listDiscussions(projectPath),
      metrics: audit.getMetrics(),
    };
  } finally {
    storage.close();
  }
}

async function update(options: Options): Promise<unknown> {
  const channel = options.channel === 'beta' ? 'beta' : 'stable';
  if (options.channel && options.channel !== 'stable' && options.channel !== 'beta') {
    throw new Error('--channel must be stable or beta');
  }
  const { release, info } = await checkForUpdate({ channel });
  if (options.install !== true || !info.updateAvailable || !release) return info;
  return installUpdate(release, info);
}

function uninstallProject(projectPath: string, confirmed: boolean, options: Options): Record<string, unknown> {
  if (!confirmed) throw new Error('Refusing to remove local state without --yes');
  const claudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const codexConfig = String(options['codex-config'] ?? defaultCodexConfig(projectPath));
  return removeProject({ projectPath, claudeConfig, codexConfig }, true);
}

function uninstallAll(confirmed: boolean, options: Options): Record<string, unknown> {
  if (!confirmed) throw new Error('Refusing to remove all AgentBridge projects without --yes');
  const removeProgram = options['remove-program'] === true;
  const installation = detectInstallation();
  if (removeProgram && installation.mode === 'source') {
    throw new Error('Cannot automatically remove a source checkout. Run uninstall-all --yes without --remove-program, then delete the repository yourself.');
  }

  const defaultClaudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const registrations = readProjectRegistry();
  const byPath = new Map<string, RegisteredProject>();
  for (const registration of registrations) byPath.set(projectPathKey(registration.projectPath), registration);
  for (const discoveredPath of listClaudeAgentBridgeProjects(defaultClaudeConfig)) {
    const projectPath = resolve(discoveredPath);
    const key = projectPathKey(projectPath);
    if (!byPath.has(key)) {
      byPath.set(key, {
        projectPath,
        claudeConfig: defaultClaudeConfig,
        codexConfig: defaultCodexConfig(projectPath),
        setupAt: 'discovered-from-claude-config',
      });
    }
  }

  const projects: Record<string, unknown>[] = [];
  const errors: Array<{ projectPath: string; error: string }> = [];
  for (const registration of byPath.values()) {
    try {
      projects.push(removeProject(registration, false));
      unregisterProject(registration.projectPath);
    } catch (cause) {
      errors.push({
        projectPath: registration.projectPath,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  let program: unknown = null;
  if (removeProgram && errors.length === 0) {
    if (installation.mode === 'npm') cleanupEmptyRegistryRoot();
    program = scheduleProgramRemoval(installation);
  }
  else if (removeProgram) program = { scheduled: false, reason: 'Project cleanup failed; program files were kept so cleanup can be retried.' };
  else cleanupEmptyRegistryRoot();
  return {
    removedProjects: projects.length,
    projects,
    errors,
    program,
    complete: errors.length === 0,
    restartRequired: true,
  };
}

function removeProject(
  registration: Pick<RegisteredProject, 'projectPath' | 'claudeConfig' | 'codexConfig'>,
  updateRegistry: boolean,
): Record<string, unknown> {
  const projectPath = resolve(registration.projectPath);
  const stateDir = resolve(projectPath, '.agentbridge');
  if (stateDir === parse(stateDir).root || stateDir === projectPath) {
    throw new Error(`Refusing to remove an unsafe state path: ${stateDir}`);
  }
  const configs = [
    removeClaudeJson(registration.claudeConfig, projectPath),
    removeCodexToml(registration.codexConfig),
  ];
  const sharedInstallRoot = stateDir === registryRoot();
  const removed: string[] = [];
  if (sharedInstallRoot) {
    for (const name of ['project.json', 'agentbridge.sqlite', 'agentbridge.sqlite-wal', 'agentbridge.sqlite-shm']) {
      const path = join(stateDir, name);
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
  } else if (existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true });
    removed.push(stateDir);
  }
  if (updateRegistry) unregisterProject(projectPath);
  return { projectPath, removed, configs, sharedInstallRoot };
}

function parseCodexMode(value: string): CodexBackendMode {
  if (value === 'auto' || value === 'app-server' || value === 'cli') return value;
  throw new Error('--codex-mode must be auto, app-server, or cli');
}

function projectPathKey(value: string): string {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function openStorage(projectPath: string): Storage {
  const dbPath = process.env.AGENTBRIDGE_DB_PATH ?? join(projectPath, '.agentbridge', 'agentbridge.sqlite');
  return new Storage(dbPath);
}

function readProject(projectPath: string): Record<string, unknown> | null {
  const projectFile = join(projectPath, '.agentbridge', 'project.json');
  if (!existsSync(projectFile)) return null;
  return JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
}

function parseArgs(args: string[]): { options: Options; positional: string[] } {
  const options: Options = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
    } else if (args[index + 1] && !args[index + 1].startsWith('--')) {
      options[key] = args[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { options, positional };
}

function printHelp(): void {
  console.log([
    'AgentBridge local management',
    '',
    'Commands:',
    '  init [path]                 Create .agentbridge/project.json',
    '  setup [path]                Initialize local state and MCP config',
    '  register-session             Register a provider-native session',
    '  status [path]               Show sessions, discussions, and metrics',
    '  doctor [path]               Diagnose install, config, database, and providers',
    '  version                     Show the installed AgentBridge version',
    '  update [--install]          Check GitHub Releases; install only with --install',
    '  rollback                    Switch to the previous locally installed version',
    '  uninstall [path] --yes      Remove local state and AgentBridge MCP entries',
    '  uninstall-all --yes         Remove every registered project configuration',
    '  uninstall-all --yes --remove-program',
    '                              Also remove the Release/npm installation',
    '',
    'Options:',
    '  --provider claude|codex',
    '  --session-id ID',
    '  --status IDLE|BUSY|BRIDGE_OWNED|UNKNOWN',
    '  --metadata JSON',
    '  --project-path PATH',
    '  --no-config                 Do not modify Claude/Codex MCP config',
    '  --mcp-command PATH          MCP executable/command (default: current Node)',
    '  --mcp-entry PATH            MCP entry script for Node mode',
    '  --codex-mode MODE           auto (default), app-server, or cli',
    '  --codex-app-command PATH    Override Codex App Server executable',
    '  --codex-command PATH        Override Codex executable (auto/CLI)',
    '  --channel stable|beta       Select the update channel (default: stable)',
    '  --remove-program            With uninstall-all, remove installed program files',
    '  --claude-config PATH',
    '  --codex-config PATH',
  ].join('\n'));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
