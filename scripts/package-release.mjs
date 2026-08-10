import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const targetPlatform = valueAfter('--platform') ?? platform;
const targetArch = valueAfter('--arch') ?? arch;
const runtime = valueAfter('--node-runtime') ?? process.execPath;
const packageName = `AgentBridge-v${packageJson.version}-${targetPlatform}-${targetArch}`;
const artifacts = join(root, 'artifacts');
const output = join(artifacts, packageName);
const documentationFiles = [
  'README.md',
  'README.en.md',
  'README.es.md',
  'README.ai.md',
  'LICENSE',
  'NOTICE',
  'LICENSE_HISTORY.md',
  'COMMERCIAL_LICENSE.md',
];

for (const required of [
  join(root, 'release', 'agentbridge-cli.mjs'),
  join(root, 'release', 'agentbridge-mcp.mjs'),
  ...documentationFiles.map((file) => join(root, file)),
  runtime,
]) {
  if (!existsSync(required)) throw new Error(`Required release input not found: ${required}`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'app'), { recursive: true });
mkdirSync(join(output, 'runtime'), { recursive: true });
mkdirSync(join(output, 'bin'), { recursive: true });

copyFileSync(join(root, 'release', 'agentbridge-cli.mjs'), join(output, 'app', 'agentbridge-cli.mjs'));
copyFileSync(join(root, 'release', 'agentbridge-mcp.mjs'), join(output, 'app', 'agentbridge-mcp.mjs'));
for (const file of documentationFiles) {
  copyFileSync(join(root, file), join(output, file));
}
copyFileSync(join(root, 'scripts', 'install.ps1'), join(output, 'install.ps1'));
copyFileSync(join(root, 'scripts', 'install.sh'), join(output, 'install.sh'));

if (targetPlatform === 'win32') {
  copyFileSync(runtime, join(output, 'runtime', 'node.exe'));
  copyFileSync(join(root, 'scripts', 'launchers', 'agentbridge.cmd'), join(output, 'bin', 'agentbridge.cmd'));
} else {
  copyFileSync(runtime, join(output, 'runtime', 'node'));
  copyFileSync(join(root, 'scripts', 'launchers', 'agentbridge'), join(output, 'bin', 'agentbridge'));
}

writeFileSync(join(output, 'VERSION'), `${packageJson.version}\n`, 'utf8');
writeFileSync(join(output, 'release.json'), `${JSON.stringify({
  name: 'AgentBridge',
  version: packageJson.version,
  platform: targetPlatform,
  arch: targetArch,
  repository: 'HeadStone1/AgentBridge',
  node: process.versions.node,
}, null, 2)}\n`, 'utf8');

// Preserve executable bits when the package is archived on Unix.
if (targetPlatform !== 'win32') {
  const { chmodSync } = await import('node:fs');
  chmodSync(join(output, 'runtime', 'node'), 0o755);
  chmodSync(join(output, 'bin', 'agentbridge'), 0o755);
  chmodSync(join(output, 'install.sh'), 0o755);
}

console.log(JSON.stringify({ output, packageName, version: packageJson.version, platform: targetPlatform, arch: targetArch }, null, 2));

function valueAfter(flag) {
  const inline = process.argv.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
