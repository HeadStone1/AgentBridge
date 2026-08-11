import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

declare const __AGENTBRIDGE_VERSION__: string;

export const CURRENT_VERSION = typeof __AGENTBRIDGE_VERSION__ === 'string'
  ? __AGENTBRIDGE_VERSION__
  : readWorkspaceVersion();

export const DEFAULT_RELEASE_REPOSITORY = 'HeadStone1/AgentBridge';

function readWorkspaceVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return packageJson.version ?? '0.0.0-dev';
  } catch {
    return process.env.AGENTBRIDGE_VERSION ?? '0.0.0-dev';
  }
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  assets: ReleaseAsset[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  channel: 'stable' | 'beta';
  repository: string;
  releaseUrl: string | null;
  assetName: string;
  installed: boolean;
  message: string;
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').split('+', 1)[0];
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, prerelease = ''] = normalizeVersion(value).split('-', 2);
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length, 3); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

export function releaseAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  return `AgentBridge-v${normalizeVersion(version)}-${platform}-${arch}.${extension}`;
}

export function installRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENTBRIDGE_INSTALL_ROOT ?? join(homedir(), '.agentbridge'));
}

export async function checkForUpdate(options: {
  channel?: 'stable' | 'beta';
  repository?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ release: GitHubRelease | null; info: UpdateInfo }> {
  const channel = options.channel ?? 'stable';
  const repository = options.repository ?? process.env.AGENTBRIDGE_RELEASE_REPOSITORY ?? DEFAULT_RELEASE_REPOSITORY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = channel === 'stable'
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases?per_page=20`;
  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AgentBridge/${CURRENT_VERSION}` },
  });
  if (response.status === 404) {
    return {
      release: null,
      info: {
        currentVersion: CURRENT_VERSION,
        latestVersion: null,
        updateAvailable: false,
        channel,
        repository,
        releaseUrl: null,
        assetName: releaseAssetName(CURRENT_VERSION),
        installed: false,
        message: `No published ${channel} Release is available yet.`,
      },
    };
  }
  if (!response.ok) throw new Error(`GitHub Releases request failed: HTTP ${response.status}`);
  const payload = await response.json() as GitHubRelease | GitHubRelease[];
  const release = Array.isArray(payload)
    ? payload.find((item) => !item.draft && (channel === 'beta' || !item.prerelease)) ?? null
    : payload;
  const latestVersion = release ? normalizeVersion(release.tag_name) : null;
  const updateAvailable = latestVersion !== null && compareVersions(latestVersion, CURRENT_VERSION) > 0;
  const assetName = releaseAssetName(latestVersion ?? CURRENT_VERSION);
  return {
    release,
    info: {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable,
      channel,
      repository,
      releaseUrl: release?.html_url ?? null,
      assetName,
      installed: false,
      message: updateAvailable
        ? `Version ${latestVersion} is available. Run agentbridge update --install to install it.`
        : 'AgentBridge is up to date.',
    },
  };
}

export async function installUpdate(release: GitHubRelease, info: UpdateInfo): Promise<UpdateInfo> {
  if (!info.latestVersion) throw new Error('Release version is missing');
  const asset = release.assets.find((item) => item.name === info.assetName);
  const checksums = release.assets.find((item) => item.name === 'SHA256SUMS.txt');
  if (!asset) throw new Error(`Release asset not found: ${info.assetName}`);
  if (!checksums) throw new Error('Release is missing SHA256SUMS.txt; refusing an unverified update');

  const directory = mkdtempSync(join(tmpdir(), 'agentbridge-update-'));
  try {
    const archivePath = join(directory, asset.name);
    const checksumPath = join(directory, checksums.name);
    await download(asset.browser_download_url, archivePath);
    await download(checksums.browser_download_url, checksumPath);
    verifyChecksum(archivePath, readFileSync(checksumPath, 'utf8'));

    const extract = process.platform === 'win32'
      ? spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        directory,
      ], { stdio: 'pipe', windowsHide: true })
      : spawnSync('tar', ['-xf', archivePath, '-C', directory], { stdio: 'pipe' });
    if (extract.status !== 0) {
      throw new Error(`Could not extract update: ${extract.stderr?.toString().trim() || 'tar failed'}`);
    }
    const packageDirectory = findPackageDirectory(directory);
    runInstaller(packageDirectory, installRoot());
    return { ...info, installed: true, message: `Installed AgentBridge ${info.latestVersion}. Restart Claude and Codex.` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function rollbackInstalledRelease(root = installRoot()): Record<string, unknown> {
  const currentFile = join(root, 'current');
  const versionsDirectory = join(root, 'versions');
  if (!existsSync(currentFile) || !existsSync(versionsDirectory)) {
    throw new Error('AgentBridge is not installed in versioned Release mode');
  }
  const current = readFileSync(currentFile, 'utf8').trim();
  const versions = readdirSync(versionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions);
  const candidates = versions.filter((version) => compareVersions(version, current) < 0);
  const previous = candidates.at(-1);
  if (!previous) throw new Error(`No installed version older than ${current} is available`);
  writeFileSync(currentFile, `${previous}\n`, 'utf8');
  return { previousVersion: current, currentVersion: previous, installRoot: root };
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { headers: { 'User-Agent': `AgentBridge/${CURRENT_VERSION}` }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function verifyChecksum(archivePath: string, checksumList: string): void {
  const name = basename(archivePath);
  const line = checksumList.split(/\r?\n/).find((item) => item.trim().endsWith(name));
  if (!line) throw new Error(`Checksum not found for ${name}`);
  const expected = line.trim().split(/\s+/, 1)[0].toLowerCase();
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum verification failed for ${name}`);
}

function findPackageDirectory(directory: string): string {
  const directInstaller = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
  if (existsSync(join(directory, directInstaller))) return directory;
  const child = readdirSync(directory, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, directInstaller)));
  if (!child) throw new Error(`Extracted release does not contain ${directInstaller}`);
  return join(directory, child.name);
}

function runInstaller(packageDirectory: string, targetRoot: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(packageDirectory, 'install.ps1'),
      '-NoSetup',
      '-InstallRoot', targetRoot,
    ], { cwd: packageDirectory, stdio: 'inherit', windowsHide: true })
    : spawnSync('sh', [join(packageDirectory, 'install.sh'), '--no-setup', '--install-root', targetRoot], {
      cwd: packageDirectory,
      stdio: 'inherit',
    });
  if (result.status !== 0) throw new Error(`Installer exited with status ${result.status ?? 'unknown'}`);
}
