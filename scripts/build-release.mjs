import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const outputDir = join(root, 'release');
mkdirSync(outputDir, { recursive: true });
const entries = [
  ['agentbridge-mcp.mjs', join(root, 'packages', 'mcp', 'dist', 'cli.js')],
  ['agentbridge-cli.mjs', join(root, 'packages', 'cli', 'dist', 'index.js')],
];

for (const [name, entry] of entries) {
  const output = join(outputDir, name);
  buildSync({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __AGENTBRIDGE_VERSION__: JSON.stringify(version) },
    logLevel: 'info',
  });
}

console.log(JSON.stringify({ outputDir, artifacts: entries.map(([name]) => join(outputDir, name)) }, null, 2));
