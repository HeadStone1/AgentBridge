import {
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  readProjectRegistry,
  registerProject,
  registryPath,
  registryRoot,
  unregisterProject,
} from '@agentbridge/storage';
export {
  readProjectRegistry,
  registerProject,
  registryPath,
  registryRoot,
  unregisterProject,
} from '@agentbridge/storage';
export type { RegisteredProject } from '@agentbridge/storage';

export type InstallationMode = 'release' | 'npm' | 'source';

export interface InstallationInfo {
  mode: InstallationMode;
  sourceIndependent: boolean;
  installRoot: string | null;
  launcher: string | null;
  programEntry: string;
  valid: boolean;
  issues: string[];
}

export interface ProgramRemovalResult {
  mode: Exclude<InstallationMode, 'source'>;
  scheduled: true;
  target: string;
  message: string;
}

export function detectInstallation(
  env: NodeJS.ProcessEnv = process.env,
  programEntry = process.argv[1] ?? '',
): InstallationInfo {
  const entryCandidate = resolve(programEntry || '.');
  let entry = entryCandidate;
  try { entry = realpathSync(entryCandidate); } catch { /* diagnostics will report the missing entry */ }
  const rootValue = env.AGENTBRIDGE_INSTALL_ROOT;
  const launcher = env.AGENTBRIDGE_LAUNCHER ? resolve(env.AGENTBRIDGE_LAUNCHER) : null;
  if (rootValue || launcher) {
    const root = resolve(rootValue ?? join(dirname(launcher!), '..'));
    const issues: string[] = [];
    if (!existsSync(join(root, 'current'))) issues.push('missing current version pointer');
    if (!existsSync(join(root, 'versions'))) issues.push('missing versions directory');
    if (!launcher || !existsSync(launcher)) issues.push('release launcher is missing');
    return {
      mode: 'release',
      sourceIndependent: true,
      installRoot: root,
      launcher,
      programEntry: entry,
      valid: issues.length === 0,
      issues,
    };
  }

  const normalized = entry.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/node_modules/@headstone/agentbridge/')) {
    return {
      mode: 'npm',
      sourceIndependent: true,
      installRoot: null,
      launcher: null,
      programEntry: entry,
      valid: existsSync(entry),
      issues: existsSync(entry) ? [] : ['npm package entry is missing'],
    };
  }

  return {
    mode: 'source',
    sourceIndependent: false,
    installRoot: null,
    launcher: null,
    programEntry: entry,
    valid: existsSync(entry),
    issues: existsSync(entry) ? ['development mode depends on the source checkout'] : ['CLI entry is missing'],
  };
}

export function assertUpdateSupported(installation: InstallationInfo): void {
  if (installation.mode === 'npm') {
    throw new Error('This AgentBridge installation is managed by npm. Run `npm install --global @headstone/agentbridge@latest` instead.');
  }
  if (installation.mode === 'source') {
    throw new Error('This AgentBridge installation is a source checkout. Pull the desired commit and rebuild it instead of installing a release over the checkout.');
  }
}

export function scheduleProgramRemoval(installation: InstallationInfo): ProgramRemovalResult {
  if (installation.mode === 'source') {
    throw new Error('Program removal is unavailable in source development mode; remove the source checkout manually after project cleanup');
  }
  if (installation.mode === 'release') {
    const root = validateReleaseRemovalTarget(installation);
    spawnDetachedRemoval(root);
    return {
      mode: 'release',
      scheduled: true,
      target: root,
      message: 'Release files will be removed after AgentBridge and its launcher exit.',
    };
  }
  spawnDetachedNpmUninstall();
  return {
    mode: 'npm',
    scheduled: true,
    target: '@headstone/agentbridge',
    message: 'The global npm package will be removed after AgentBridge exits.',
  };
}

export function cleanupEmptyRegistryRoot(env: NodeJS.ProcessEnv = process.env): void {
  const root = registryRoot(env);
  if (!existsSync(root) || !statSync(root).isDirectory()) return;
  if (readdirSync(root).length === 0) rmSync(root, { recursive: false });
}

function validateReleaseRemovalTarget(installation: InstallationInfo): string {
  const root = resolve(installation.installRoot ?? '');
  if (!installation.installRoot || root === parse(root).root) {
    throw new Error('Refusing to remove an unsafe AgentBridge install root');
  }
  if (!isAbsolute(root) || !existsSync(join(root, 'current')) || !existsSync(join(root, 'versions'))) {
    throw new Error(`Refusing to remove an unrecognized AgentBridge install root: ${root}`);
  }
  if (installation.launcher) {
    const launcherRelative = relative(root, resolve(installation.launcher));
    if (launcherRelative.startsWith('..') || isAbsolute(launcherRelative)) {
      throw new Error('Refusing to remove an install root that does not contain the active launcher');
    }
  }
  return root;
}

function spawnDetachedRemoval(root: string): void {
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      '$ids=@($env:AB_REMOVE_PID,$env:AB_REMOVE_PPID); foreach($id in $ids){ if($id){ Wait-Process -Id ([int]$id) -ErrorAction SilentlyContinue } }; do { $active=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith([IO.Path]::GetFullPath($env:AB_REMOVE_ROOT),[StringComparison]::OrdinalIgnoreCase) } catch { $false } }); if($active.Count -gt 0){ Start-Sleep -Seconds 1 } } while($active.Count -gt 0); Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath $env:AB_REMOVE_ROOT -Recurse -Force',
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: removalEnv({ AB_REMOVE_ROOT: root }),
    })
    : spawn('sh', [
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 1; done; rm -rf -- "$2"',
      'agentbridge-uninstall', String(process.pid), root,
    ], { detached: true, stdio: 'ignore' });
  child.unref();
}

function spawnDetachedNpmUninstall(): void {
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      'Wait-Process -Id ([int]$env:AB_REMOVE_PID) -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; & npm.cmd uninstall --global @headstone/agentbridge',
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: removalEnv(),
    })
    : spawn('sh', [
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 1; done; npm uninstall --global @headstone/agentbridge',
      'agentbridge-uninstall', String(process.pid),
    ], { detached: true, stdio: 'ignore' });
  child.unref();
}

function removalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AB_REMOVE_PID: String(process.pid),
    AB_REMOVE_PPID: String(process.ppid),
    ...extra,
  };
}
