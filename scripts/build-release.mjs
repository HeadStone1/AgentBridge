import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
if (!existsSync(esbuild)) throw new Error('esbuild is required; run npm install first');

const outputDir = join(root, 'release');
mkdirSync(outputDir, { recursive: true });
const entries = [
  ['agentbridge-mcp.mjs', join(root, 'packages', 'mcp', 'dist', 'cli.js')],
  ['agentbridge-cli.mjs', join(root, 'packages', 'cli', 'dist', 'index.js')],
];

for (const [name, entry] of entries) {
  const output = join(outputDir, name);
  const result = spawnSync(process.execPath, [
    esbuild,
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    `--define:__AGENTBRIDGE_VERSION__=${JSON.stringify(version)}`,
    `--outfile=${output}`,
  ], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ outputDir, artifacts: entries.map(([name]) => join(outputDir, name)) }, null, 2));
