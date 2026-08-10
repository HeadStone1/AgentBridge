import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstallation, readProjectRegistry, registerProject, unregisterProject } from '../../packages/cli/src/installation.js';

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('system installation and diagnostics', () => {
  it('maintains a cross-platform project registry without duplicate paths', () => {
    const root = temporaryDirectory();
    const env = { ...process.env, AGENTBRIDGE_INSTALL_ROOT: join(root, 'install') };
    const project = join(root, 'project');
    registerProject({ projectPath: project, claudeConfig: join(root, 'claude.json'), codexConfig: join(project, '.codex', 'config.toml') }, env);
    registerProject({ projectPath: project, claudeConfig: join(root, 'claude-2.json'), codexConfig: join(project, '.codex', 'config-2.toml') }, env);
    expect(readProjectRegistry(env)).toHaveLength(1);
    expect(readProjectRegistry(env)[0].claudeConfig).toContain('claude-2.json');
    expect(unregisterProject(project, env)).toEqual([]);
  });

  it('recognizes a self-contained Release installation from launcher metadata', () => {
    const root = temporaryDirectory();
    const installRoot = join(root, 'AgentBridge');
    const launcher = join(installRoot, 'bin', process.platform === 'win32' ? 'agentbridge.cmd' : 'agentbridge');
    mkdirSync(join(installRoot, 'versions'), { recursive: true });
    mkdirSync(join(installRoot, 'bin'), { recursive: true });
    writeFileSync(join(installRoot, 'current'), '0.4.2\n');
    writeFileSync(launcher, 'launcher');
    const result = detectInstallation({
      ...process.env,
      AGENTBRIDGE_INSTALL_ROOT: installRoot,
      AGENTBRIDGE_LAUNCHER: launcher,
    }, join(root, 'agentbridge-cli.mjs'));
    expect(result).toMatchObject({ mode: 'release', sourceIndependent: true, valid: true });
  });

  it('doctor returns structured failures and does not create a missing project', () => {
    const root = temporaryDirectory();
    const missingProject = join(root, 'missing-project');
    const output = runCli([
      'doctor', missingProject,
      '--claude-config', join(root, 'claude.json'),
      '--codex-config', join(root, 'codex.toml'),
    ], { AGENTBRIDGE_INSTALL_ROOT: join(root, 'registry') });
    expect(output.ok).toBe(false);
    expect(output.project).toMatchObject({ exists: false, initialized: false });
    expect(output.database).toMatchObject({ ok: false, tested: false });
    expect(Array.isArray(output.recommendations)).toBe(true);
    expect(existsSync(missingProject)).toBe(false);
  });

  it('setup registers multiple projects and uninstall-all cleans their state and MCP entries', () => {
    const root = temporaryDirectory();
    const installRoot = join(root, 'install');
    const launcher = join(installRoot, 'bin', process.platform === 'win32' ? 'agentbridge.cmd' : 'agentbridge');
    const claudeConfig = join(root, 'claude.json');
    mkdirSync(join(installRoot, 'versions'), { recursive: true });
    mkdirSync(join(installRoot, 'bin'), { recursive: true });
    writeFileSync(join(installRoot, 'current'), '0.4.2\n');
    writeFileSync(launcher, 'launcher');
    const env = { AGENTBRIDGE_INSTALL_ROOT: installRoot, AGENTBRIDGE_LAUNCHER: launcher };

    for (const name of ['project-a', 'project-b']) {
      const project = join(root, name);
      mkdirSync(project);
      runCli([
        'setup', project,
        '--claude-config', claudeConfig,
        '--codex-config', join(project, '.codex', 'config.toml'),
      ], env);
    }
    expect(readProjectRegistry({ ...process.env, ...env })).toHaveLength(2);

    const doctor = runCli([
      'doctor', join(root, 'project-a'),
      '--claude-config', claudeConfig,
      '--codex-config', join(root, 'project-a', '.codex', 'config.toml'),
    ], env);
    expect(doctor.project).toMatchObject({ exists: true, initialized: true, metadataValid: true });
    expect(doctor.database).toMatchObject({ ok: true, tested: true });
    expect(doctor.registry).toMatchObject({ registered: true, projectCount: 2 });
    expect(doctor.configuration.claude.ok).toBe(true);
    expect(doctor.configuration.codex.ok).toBe(true);

    const result = runCli(['uninstall-all', '--yes', '--claude-config', claudeConfig], env);
    expect(result).toMatchObject({ removedProjects: 2, complete: true, program: null });
    for (const name of ['project-a', 'project-b']) {
      expect(existsSync(join(root, name, '.agentbridge'))).toBe(false);
      const codex = readFileSync(join(root, name, '.codex', 'config.toml'), 'utf8');
      expect(codex).not.toContain('[mcp_servers.agentbridge]');
    }
    const claude = JSON.parse(readFileSync(claudeConfig, 'utf8')) as { projects: Record<string, { mcpServers?: Record<string, unknown> }> };
    expect(Object.values(claude.projects).every((project) => !project.mcpServers?.agentbridge)).toBe(true);
    expect(readProjectRegistry({ ...process.env, ...env })).toEqual([]);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentbridge-install-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): any {
  const cli = join(repositoryRoot, 'packages', 'cli', 'dist', 'index.js');
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 30_000,
    windowsHide: true,
  });
  return JSON.parse(output);
}
