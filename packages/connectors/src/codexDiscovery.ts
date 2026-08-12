import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

export type CodexBackendMode = 'auto' | 'app-server' | 'cli';

export interface CodexCommandCandidate {
  command: string;
  source: 'environment' | 'bundled' | 'desktop' | 'system';
  label: string;
  mode: CodexBackendMode;
  /** Arguments placed before `app-server` or `exec` (primarily for wrappers/tests). */
  args?: string[];
}

export interface CodexDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pathExists?: (path: string) => boolean;
  readDirectory?: (path: string) => string[];
  resolveBundledCodexEntrypoint?: () => string | undefined;
}

/**
 * Return ordered Codex executable candidates without launching them.
 * Explicit configuration wins, then Desktop bundles, then PATH. Every
 * candidate is capability-probed before use.
 */
export function discoverCodexCommands(options: CodexDiscoveryOptions = {}): CodexCommandCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const readDirectory = options.readDirectory ?? ((path: string) => readdirSync(path));
  const pathApi = platform === 'win32' ? win32 : posix;
  const candidates: CodexCommandCandidate[] = [];

  addEnvironmentCandidate(candidates, env.AGENTBRIDGE_CODEX_APP_COMMAND, 'AGENTBRIDGE_CODEX_APP_COMMAND', 'app-server');
  addEnvironmentCandidate(candidates, env.AGENTBRIDGE_CODEX_COMMAND, 'AGENTBRIDGE_CODEX_COMMAND', 'auto');
  addEnvironmentCandidate(candidates, env.CODEX_CLI_PATH, 'CODEX_CLI_PATH', 'auto');

  // Explicit CLI-capable paths remain authoritative. An App Server-only
  // override still permits independent CLI discovery for safe fallback.
  if (candidates.some((candidate) => candidate.mode !== 'app-server')) {
    return deduplicate(candidates, platform === 'win32');
  }

  const bundledEntrypoint = (options.resolveBundledCodexEntrypoint ?? resolveBundledCodexEntrypoint)();
  if (bundledEntrypoint) {
    candidates.push({
      command: process.execPath,
      args: [bundledEntrypoint],
      source: 'bundled',
      label: 'AgentBridge bundled official Codex CLI',
      mode: 'auto',
    });
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      const desktopBin = pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin');
      addPathCandidate(candidates, pathApi.join(desktopBin, 'codex.exe'), 'Codex Desktop (Windows)', pathExists);
      if (pathExists(desktopBin)) {
        try {
          const versioned = readDirectory(desktopBin)
            .filter((name) => /^codex-\d+(?:\.\d+)*\.exe$/i.test(name))
            .sort(compareVersionedExecutables);
          for (const name of versioned) {
            addPathCandidate(candidates, pathApi.join(desktopBin, name), 'Codex Desktop bundled runtime (Windows)', pathExists);
          }
        } catch {
          // An unreadable installation directory is simply not a candidate.
        }
      }
      addPathCandidate(
        candidates,
        pathApi.join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe'),
        'Codex Desktop resources (Windows)',
        pathExists,
      );
    }
  } else if (platform === 'darwin') {
    addPathCandidate(candidates, '/Applications/Codex.app/Contents/Resources/codex', 'Codex Desktop (macOS)', pathExists);
    addPathCandidate(
      candidates,
      pathApi.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
      'Codex Desktop user install (macOS)',
      pathExists,
    );
  } else {
    addPathCandidate(candidates, pathApi.join(home, '.local', 'bin', 'codex'), 'User installation', pathExists);
    addPathCandidate(candidates, '/usr/local/bin/codex', 'System installation', pathExists);
  }

  candidates.push({ command: platform === 'win32' ? 'codex.exe' : 'codex', source: 'system', label: 'PATH', mode: 'auto' });
  return deduplicate(candidates, platform === 'win32');
}

function resolveBundledCodexEntrypoint(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve('@openai/codex/package.json');
    const entrypoint = join(dirname(packageJson), 'bin', 'codex.js');
    return existsSync(entrypoint) ? entrypoint : undefined;
  } catch {
    return undefined;
  }
}

function compareVersionedExecutables(left: string, right: string): number {
  const parts = (value: string) => (value.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

function addEnvironmentCandidate(
  candidates: CodexCommandCandidate[],
  command: string | undefined,
  label: string,
  mode: CodexBackendMode,
): void {
  if (!command?.trim()) return;
  candidates.push({ command: command.trim(), source: 'environment', label, mode });
}

function addPathCandidate(
  candidates: CodexCommandCandidate[],
  command: string,
  label: string,
  pathExists: (path: string) => boolean,
): void {
  if (!pathExists(command)) return;
  candidates.push({ command, source: 'desktop', label, mode: 'auto' });
}

function deduplicate(candidates: CodexCommandCandidate[], caseInsensitive: boolean): CodexCommandCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = caseInsensitive ? candidate.command.toLowerCase() : candidate.command;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
