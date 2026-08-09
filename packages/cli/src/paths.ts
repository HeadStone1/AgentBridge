import { basename, dirname, join, resolve } from 'node:path';

/** Resolve the MCP entry beside either the workspace CLI build or release bundle. */
export function resolveMcpEntry(invoked: string | undefined): string {
  if (!invoked) return resolve('packages', 'mcp', 'dist', 'cli.js');
  const invokedPath = resolve(invoked);
  if (basename(invokedPath) === 'agentbridge-cli.mjs') {
    return join(dirname(invokedPath), 'agentbridge-mcp.mjs');
  }
  return resolve(dirname(invokedPath), '..', '..', 'mcp', 'dist', 'cli.js');
}

export function defaultCodexConfig(projectPath: string): string {
  return join(resolve(projectPath), '.codex', 'config.toml');
}
