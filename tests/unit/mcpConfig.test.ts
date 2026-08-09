import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  claudeProjectKey,
  configureClaudeJson,
  configureCodexToml,
  removeClaudeJson,
  removeCodexToml,
} from '../../packages/cli/src/mcpConfig.js';

describe('MCP configuration management', () => {
  it('updates Claude JSON incrementally and creates a backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(directory, 'claude.json');
    const projectPath = join(directory, 'project-a');
    const otherProjectPath = join(directory, 'project-b');
    writeFileSync(path, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } }, other: true }));
    try {
      const result = configureClaudeJson(path, { command: 'node', args: ['mcp-a.js'] }, projectPath);
      configureClaudeJson(path, { command: 'node', args: ['mcp-b.js'] }, otherProjectPath);
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBe(`${path}.agentbridge.bak`);
      expect(value.other).toBe(true);
      expect(value.mcpServers.existing.command).toBe('keep-me');
      expect(value.mcpServers.agentbridge).toBeUndefined();
      expect(value.projects[claudeProjectKey(projectPath)].mcpServers.agentbridge.args).toEqual(['mcp-a.js']);
      expect(value.projects[claudeProjectKey(otherProjectPath)].mcpServers.agentbridge.args).toEqual(['mcp-b.js']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upserts the Codex TOML section without dropping neighboring sections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(directory, 'config.toml');
    writeFileSync(path, '[profiles.default]\nmodel = \'keep\'\n');
    try {
      configureCodexToml(path, { command: 'node', args: ['mcp.js'], cwd: directory });
      const value = readFileSync(path, 'utf8');
      expect(value).toContain('[profiles.default]');
      expect(value).toContain('[mcp_servers.agentbridge]');
      expect(value).toContain("command = 'node'");
      expect(value).toContain(`cwd = '${directory.replace(/'/g, "''")}'`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes only AgentBridge entries during uninstall', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const claudePath = join(directory, 'claude.json');
    const codexPath = join(directory, 'config.toml');
    const projectPath = join(directory, 'project');
    writeFileSync(claudePath, JSON.stringify({
      mcpServers: { agentbridge: { command: 'legacy' }, existing: { command: 'keep' } },
      projects: { [claudeProjectKey(projectPath)]: { mcpServers: { agentbridge: { command: 'node' }, scoped: { command: 'keep-scoped' } } } },
    }));
    writeFileSync(codexPath, '[mcp_servers.agentbridge]\ncommand = \'node\'\n\n[profiles.default]\nmodel = \'keep\'\n');
    try {
      expect(removeClaudeJson(claudePath, projectPath).changed).toBe(true);
      expect(removeCodexToml(codexPath).changed).toBe(true);
      const claude = JSON.parse(readFileSync(claudePath, 'utf8')) as Record<string, any>;
      const codex = readFileSync(codexPath, 'utf8');
      expect(claude.mcpServers.agentbridge).toBeUndefined();
      expect(claude.mcpServers.existing.command).toBe('keep');
      expect(claude.projects[claudeProjectKey(projectPath)].mcpServers.agentbridge).toBeUndefined();
      expect(claude.projects[claudeProjectKey(projectPath)].mcpServers.scoped.command).toBe('keep-scoped');
      expect(codex).not.toContain('[mcp_servers.agentbridge]');
      expect(codex).toContain('[profiles.default]');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
