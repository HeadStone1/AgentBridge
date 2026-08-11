import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  claudeProjectKey,
  configureClaudeGlobal,
  configureClaudeJson,
  configureCodexToml,
  removeClaudeGlobal,
  removeClaudeJson,
  removeCodexToml,
} from '../../packages/cli/src/mcpConfig.js';

describe('MCP configuration management', () => {
  it('configures Claude globally, preserves unrelated entries, and migrates scoped copies', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(directory, 'claude.json');
    const projectPath = join(directory, 'project-a');
    const otherProjectPath = join(directory, 'project-b');
    writeFileSync(path, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } }, other: true }));
    try {
      configureClaudeJson(path, { command: 'old-node', args: ['mcp-a.js'] }, projectPath);
      configureClaudeJson(path, { command: 'old-node', args: ['mcp-b.js'] }, otherProjectPath);
      const result = configureClaudeGlobal(path, { command: 'node', args: ['mcp.js'], env: { AGENTBRIDGE_AGENT: 'claude' } });
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBe(`${path}.agentbridge.bak`);
      expect(value.other).toBe(true);
      expect(value.mcpServers.existing.command).toBe('keep-me');
      expect(value.mcpServers.agentbridge.args).toEqual(['mcp.js']);
      expect(value.projects[claudeProjectKey(projectPath)].mcpServers.agentbridge).toBeUndefined();
      expect(value.projects[claudeProjectKey(otherProjectPath)].mcpServers.agentbridge).toBeUndefined();
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
      expect(value).toContain('command = "node"');
      expect(value).toContain(`cwd = "${directory.replace(/\\/g, '\\\\').replace(/"/g, '\\\"')}"`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('escapes apostrophes, quotes, backslashes, and newlines in TOML basic strings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(directory, 'config.toml');
    try {
      configureCodexToml(path, {
        command: 'node"runner',
        args: ["O'Reilly", 'C:\\temp\\agent', 'line\nnext'],
      });
      const value = readFileSync(path, 'utf8');
      expect(value).toContain('command = "node\\"runner"');
      expect(value).toContain('args = ["O\'Reilly", "C:\\\\temp\\\\agent", "line\\nnext"]');
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
      expect(removeClaudeGlobal(claudePath).changed).toBe(true);
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

  it('removing a legacy project entry never removes the global Claude server', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(directory, 'claude.json');
    const projectPath = join(directory, 'project');
    writeFileSync(path, JSON.stringify({
      mcpServers: { agentbridge: { command: 'global' }, keep: { command: 'keep' } },
      projects: {
        [claudeProjectKey(projectPath)]: {
          mcpServers: { agentbridge: { command: 'legacy-project' } },
        },
      },
    }));
    try {
      expect(removeClaudeJson(path, projectPath).changed).toBe(true);
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(value.mcpServers.agentbridge.command).toBe('global');
      expect(value.projects[claudeProjectKey(projectPath)].mcpServers.agentbridge).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
