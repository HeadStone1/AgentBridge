#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const raw = await readFile(0, 'utf8').catch(() => '');
let input = {};
if (raw.trim()) {
  try { input = JSON.parse(raw); } catch { input = {}; }
}

const provider = input.provider ?? process.env.AGENTBRIDGE_AGENT;
const sessionId = input.sessionId ?? input.session_id ?? process.env.AGENTBRIDGE_SESSION_ID;
const projectPath = input.projectPath ?? input.project_path ?? process.env.AGENTBRIDGE_PROJECT_PATH ?? process.cwd();
if (!['claude', 'codex'].includes(provider) || typeof sessionId !== 'string' || !sessionId) {
  console.error('register-session hook requires provider and sessionId');
  process.exit(2);
}

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'register-session', '--provider', provider, '--session-id', sessionId, '--project-path', projectPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
process.exit(result.status ?? 1);
