import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, 'artifacts', 'npm');
const releaseDirectory = join(output, 'release');

for (const required of [
  join(root, 'release', 'agentbridge-cli.mjs'),
  join(root, 'release', 'agentbridge-mcp.mjs'),
  join(root, 'README.md'),
  join(root, 'LICENSE'),
]) {
  if (!existsSync(required)) throw new Error(`Required npm package input not found: ${required}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(releaseDirectory, { recursive: true });
copyFileSync(join(root, 'release', 'agentbridge-cli.mjs'), join(releaseDirectory, 'agentbridge-cli.mjs'));
copyFileSync(join(root, 'release', 'agentbridge-mcp.mjs'), join(releaseDirectory, 'agentbridge-mcp.mjs'));
copyFileSync(join(root, 'README.md'), join(output, 'README.md'));
copyFileSync(join(root, 'LICENSE'), join(output, 'LICENSE'));

const packageJson = {
  name: '@headstone/agentbridge',
  version: sourcePackage.version,
  description: 'Local-first MCP collaboration bridge for Claude Code and OpenAI Codex',
  type: 'module',
  license: 'Apache-2.0',
  bin: {
    agentbridge: 'release/agentbridge-cli.mjs',
    'agentbridge-mcp': 'release/agentbridge-mcp.mjs',
  },
  files: ['release', 'README.md', 'LICENSE'],
  engines: { node: '>=22.13' },
  repository: { type: 'git', url: 'git+https://github.com/HeadStone1/AgentBridge.git' },
  homepage: 'https://github.com/HeadStone1/AgentBridge#readme',
  bugs: { url: 'https://github.com/HeadStone1/AgentBridge/issues' },
  keywords: ['mcp', 'claude', 'codex', 'agent', 'collaboration'],
  publishConfig: { access: 'public' },
};

writeFileSync(join(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, name: packageJson.name, version: packageJson.version }, null, 2));
