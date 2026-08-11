import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const sourceRoots = ['packages', 'tests', 'scripts', 'hooks']
  .map((name) => join(root, name))
  .filter((path) => existsSync(path));
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sh', '.yml', '.yaml']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = [];
let checked = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue;
    checked += 1;
    try {
      decoder.decode(readFileSync(path));
    } catch {
      invalid.push(relative(root, path));
    }
  }
}

for (const sourceRoot of sourceRoots) walk(sourceRoot);

if (invalid.length > 0) {
  console.error(`UTF-8 source check failed for ${invalid.length} file(s):`);
  for (const path of invalid) console.error(`- ${path}`);
  process.exit(1);
}

console.log(`UTF-8 source check passed (${checked} files).`);
