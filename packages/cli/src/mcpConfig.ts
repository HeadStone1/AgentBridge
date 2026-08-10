import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface McpServerCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ConfigUpdateResult {
  provider: 'claude' | 'codex';
  path: string;
  changed: boolean;
  backupPath?: string;
}

export function configureClaudeJson(path: string, server: McpServerCommand, projectPath: string): ConfigUpdateResult {
  const existing = readJsonObject(path);
  const projects = isRecord(existing.projects) ? { ...existing.projects } : {};
  const projectKey = claudeProjectKey(projectPath);
  const legacyProjectKey = projectKey !== projectPath && isRecord(projects[projectPath]);
  const projectSource = isRecord(projects[projectKey]) ? projects[projectKey] : projects[projectPath];
  const project = isRecord(projectSource) ? { ...projectSource } : {};
  const servers = isRecord(project.mcpServers) ? { ...project.mcpServers } : {};
  const nextServer = { command: server.command, args: server.args ?? [], env: server.env ?? {} };
  const topLevelServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : undefined;
  const hadLegacyTopLevel = Boolean(topLevelServers && Object.prototype.hasOwnProperty.call(topLevelServers, 'agentbridge'));
  const changed = hadLegacyTopLevel || legacyProjectKey || JSON.stringify(servers.agentbridge) !== JSON.stringify(nextServer);
  if (!changed) return { provider: 'claude', path, changed: false };

  servers.agentbridge = nextServer;
  project.mcpServers = servers;
  projects[projectKey] = project;
  if (legacyProjectKey) delete projects[projectPath];
  const next: Record<string, any> = { ...existing, projects };
  if (topLevelServers) {
    delete topLevelServers.agentbridge;
    if (Object.keys(topLevelServers).length > 0) next.mcpServers = topLevelServers;
    else delete next.mcpServers;
  }
  const backupPath = backupExisting(path);
  writeJsonAtomic(path, next);
  return { provider: 'claude', path, changed: true, backupPath };
}

export function removeClaudeJson(path: string, projectPath: string): ConfigUpdateResult {
  const existing = readJsonObject(path);
  const projects = isRecord(existing.projects) ? { ...existing.projects } : {};
  const projectKey = claudeProjectKey(projectPath);
  const normalizedProject = isRecord(projects[projectKey]) ? { ...projects[projectKey] } : {};
  const legacyProject = projectKey !== projectPath && isRecord(projects[projectPath]) ? { ...projects[projectPath] } : {};
  const project = Object.keys(normalizedProject).length > 0 ? normalizedProject : legacyProject;
  const servers = isRecord(project.mcpServers) ? { ...project.mcpServers } : {};
  const topLevelServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : undefined;
  const hasScoped = Object.prototype.hasOwnProperty.call(servers, 'agentbridge');
  const hasLegacy = Boolean(topLevelServers && Object.prototype.hasOwnProperty.call(topLevelServers, 'agentbridge'));
  if (!hasScoped && !hasLegacy) {
    return { provider: 'claude', path, changed: false };
  }
  delete servers.agentbridge;
  project.mcpServers = servers;
  projects[projectKey] = project;
  if (projectKey !== projectPath) delete projects[projectPath];
  const next: Record<string, any> = { ...existing, projects };
  if (topLevelServers) {
    delete topLevelServers.agentbridge;
    if (Object.keys(topLevelServers).length > 0) next.mcpServers = topLevelServers;
    else delete next.mcpServers;
  }
  const backupPath = backupExisting(path);
  writeJsonAtomic(path, next);
  return { provider: 'claude', path, changed: true, backupPath };
}

export function listClaudeAgentBridgeProjects(path: string): string[] {
  if (!existsSync(path)) return [];
  const existing = readJsonObject(path);
  const projects = isRecord(existing.projects) ? existing.projects : {};
  return Object.entries(projects)
    .filter(([, value]) => isRecord(value)
      && isRecord(value.mcpServers)
      && Object.prototype.hasOwnProperty.call(value.mcpServers, 'agentbridge'))
    .map(([projectPath]) => projectPath);
}

export function configureCodexToml(path: string, server: McpServerCommand): ConfigUpdateResult {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const section = [
    '[mcp_servers.agentbridge]',
    `command = '${tomlString(server.command)}'`,
    `args = [${(server.args ?? []).map((arg) => `'${tomlString(arg)}'`).join(', ')}]`,
    ...(server.cwd ? [`cwd = '${tomlString(server.cwd)}'`] : []),
    ...Object.entries(server.env ?? {}).map(([key, value]) => `env.${key} = '${tomlString(value)}'`),
    '',
  ].join('\n');
  const next = upsertTomlSection(existing, 'mcp_servers.agentbridge', section);
  if (next === existing) return { provider: 'codex', path, changed: false };

  const backupPath = backupExisting(path);
  writeTextAtomic(path, next);
  return { provider: 'codex', path, changed: true, backupPath };
}

export function removeCodexToml(path: string): ConfigUpdateResult {
  if (!existsSync(path)) return { provider: 'codex', path, changed: false };
  const existing = readFileSync(path, 'utf8');
  const next = removeTomlSection(existing, 'mcp_servers.agentbridge');
  if (next === existing) return { provider: 'codex', path, changed: false };
  const backupPath = backupExisting(path);
  writeTextAtomic(path, next);
  return { provider: 'codex', path, changed: true, backupPath };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`MCP config must contain a JSON object: ${path}`);
  return value;
}

function upsertTomlSection(input: string, sectionName: string, replacement: string): string {
  const header = `[${sectionName}]`;
  const lines = input.length === 0 ? [] : input.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const prefix = input.length > 0 && !input.endsWith('\n') ? `${input}\n` : input;
    return `${prefix}\n${replacement}`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const nextLines = [...lines.slice(0, start), replacement.trimEnd(), ...lines.slice(end)];
  return `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
}

function removeTomlSection(input: string, sectionName: string): string {
  const header = `[${sectionName}]`;
  const lines = input.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return input;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const nextLines = [...lines.slice(0, start), ...lines.slice(end)];
  return `${nextLines.join('\n').replace(/\n+$/, '')}${nextLines.length > 0 ? '\n' : ''}`;
}

function backupExisting(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backupPath = `${path}.agentbridge.bak`;
  writeFileSync(backupPath, readFileSync(path));
  return backupPath;
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.agentbridge.tmp-${process.pid}`;
  writeFileSync(tempPath, value, 'utf8');
  renameSync(tempPath, path);
}

function tomlString(value: string): string {
  return value.replace(/'/g, "''");
}

export function claudeProjectKey(projectPath: string): string {
  return projectPath.replace(/\\/g, '/');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
