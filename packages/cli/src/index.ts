#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  ClaudeConnector,
  CodexAutoConnector,
  CodexConnector,
  discoverCodexCommands,
  type CodexBackendMode,
} from '@agentbridge/connectors';
import { AuditService } from '@agentbridge/audit';
import { Storage } from '@agentbridge/storage';
import type { AgentType, SessionStatus } from '@agentbridge/protocol';
import { configureClaudeJson, configureCodexToml, removeClaudeJson, removeCodexToml } from './mcpConfig.js';
import { defaultCodexConfig, resolveMcpEntry } from './paths.js';
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
      console.log(JSON.stringify(await doctor(projectPath, options), null, 2));
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
      console.log(JSON.stringify(uninstall(projectPath, options.yes === true, options), null, 2));
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
  if (options['no-config'] === true) return { project, configured: [] };

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
  const claudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const codexConfig = String(options['codex-config'] ?? defaultCodexConfig(projectPath));
  return {
    project,
    codexBackend: {
      strategy: sharedEnv.AGENTBRIDGE_CODEX_MODE ?? 'auto',
      appServerFirst: (sharedEnv.AGENTBRIDGE_CODEX_MODE ?? 'auto') !== 'cli',
      automaticDesktopDiscovery: !sharedEnv.AGENTBRIDGE_CODEX_APP_COMMAND && !sharedEnv.AGENTBRIDGE_CODEX_COMMAND,
    },
    configured: [
      configureClaudeJson(claudeConfig, claudeServer, projectPath),
      configureCodexToml(codexConfig, codexServer),
    ],
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

async function doctor(projectPath: string, options: Options = {}): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    node: { version: process.versions.node, supported: isSupportedNode(process.versions.node) },
    project: { path: projectPath, initialized: existsSync(join(projectPath, '.agentbridge', 'project.json')) },
  };
  const storage = openStorage(projectPath);
  storage.recoverExpiredSessionLeases();
  storage.close();
  const codexMode = parseCodexMode(String(options['codex-mode'] ?? process.env.AGENTBRIDGE_CODEX_MODE ?? 'auto'));
  const discoveryEnv = { ...process.env };
  if (typeof options['codex-app-command'] === 'string') {
    discoveryEnv.AGENTBRIDGE_CODEX_APP_COMMAND = options['codex-app-command'];
  }
  if (typeof options['codex-command'] === 'string') {
    discoveryEnv.AGENTBRIDGE_CODEX_COMMAND = options['codex-command'];
  }
  const codexAuto = new CodexAutoConnector({
    mode: codexMode,
    candidates: discoverCodexCommands({ env: discoveryEnv }),
  });
  const [claude, codexSelection, codexAppDetected] = await Promise.all([
    new ClaudeConnector({ command: process.env.AGENTBRIDGE_CLAUDE_COMMAND }).isAvailable(),
    codexAuto.getSelection(),
    isProcessRunning('codex'),
  ]);
  const codexCli = codexSelection
    ? await new CodexConnector({ command: codexSelection.command }).isAvailable()
    : false;
  checks.providers = {
    claudeCli: claude,
    codexCli,
    codexAppServer: codexSelection?.mode === 'app-server',
    codexSelectedBackend: codexSelection ?? null,
    codexCandidates: codexAuto.getCandidates().map(({ command, source, label, mode }) => ({ command, source, label, mode })),
    codexAppDetected,
    availability: {
      claude: claude ? 'BACKGROUND' : 'UNAVAILABLE',
      codex: codexSelection ? 'BACKGROUND' : 'UNAVAILABLE',
    },
    note: 'App Server is preferred. codexAppDetected is informational; AgentBridge only uses capability-probed executables and does not attach to an open GUI session.',
  };
  checks.database = { readable: true, path: process.env.AGENTBRIDGE_DB_PATH ?? join(projectPath, '.agentbridge', 'agentbridge.sqlite') };
  return checks;
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

function isProcessRunning(processName: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'tasklist' : 'ps';
  const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='];
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2_000);
    child.stdout?.on('data', (chunk: Buffer | string) => { output += chunk.toString(); });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && output.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

function uninstall(projectPath: string, confirmed: boolean, options: Options): Record<string, unknown> {
  const stateDir = resolve(projectPath, '.agentbridge');
  if (!confirmed) throw new Error('Refusing to remove local state without --yes');
  if (resolve(stateDir).split('\\').length < 3) throw new Error('Refusing to remove an unsafe state path');
  const claudeConfig = String(options['claude-config'] ?? join(homedir(), '.claude.json'));
  const codexConfig = String(options['codex-config'] ?? defaultCodexConfig(projectPath));
  const configResults = [removeClaudeJson(claudeConfig, projectPath), removeCodexToml(codexConfig)];
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  return { projectPath, removed: stateDir, configs: configResults };
}

function isSupportedNode(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

function parseCodexMode(value: string): CodexBackendMode {
  if (value === 'auto' || value === 'app-server' || value === 'cli') return value;
  throw new Error('--codex-mode must be auto, app-server, or cli');
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

function printHelpLegacy(): void {
  console.log(`AgentBridge local management\n\nCommands:\n  init [path]                 Create .agentbridge/project.json\n  setup [path]                Initialize local state and MCP config\n  register-session             Register a provider-native session\n  status [path]               Show sessions, discussions, and metrics\n  doctor [path]               Check Node, database, and provider reachability\n  uninstall [path] --yes      Remove only the project's .agentbridge state\n\nOptions:\n  --provider claude|codex\n  --session-id ID\n  --status IDLE|BUSY|BRIDGE_OWNED|UNKNOWN\n  --metadata JSON\n  --project-path PATH\n  --no-config                 Do not modify Claude/Codex MCP config\n  --mcp-command PATH          MCP executable/command (default: current Node)\n  --mcp-entry PATH            MCP entry script for Node mode\n  --claude-config PATH\n  --codex-config PATH`);
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
    '  doctor [path]               Check Node, database, and provider reachability',
    '  version                     Show the installed AgentBridge version',
    '  update [--install]          Check GitHub Releases; install only with --install',
    '  rollback                    Switch to the previous locally installed version',
    '  uninstall [path] --yes      Remove local state and AgentBridge MCP entries',
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
    '  --claude-config PATH',
    '  --codex-config PATH',
  ].join('\n'));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
