import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCodexConfig, resolveMcpEntry } from '../../packages/cli/src/paths.js';

describe('CLI MCP entry resolution', () => {
  it('resolves the workspace build to packages/mcp/dist/cli.js', () => {
    const invoked = resolve('packages', 'cli', 'dist', 'index.js');
    expect(resolveMcpEntry(invoked)).toBe(resolve('packages', 'mcp', 'dist', 'cli.js'));
  });

  it('resolves the release CLI to its sibling MCP bundle', () => {
    const invoked = resolve('release', 'agentbridge-cli.mjs');
    expect(resolveMcpEntry(invoked)).toBe(resolve('release', 'agentbridge-mcp.mjs'));
  });

  it('stores Codex MCP configuration in the target project', () => {
    const projectPath = resolve('project-a');
    expect(defaultCodexConfig(projectPath)).toBe(resolve(projectPath, '.codex', 'config.toml'));
  });
});
