import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mcp = join(root, 'packages', 'mcp', 'dist', 'cli.js');
const directory = mkdtempSync(join(tmpdir(), 'agentbridge-baseline-'));
const reportPath = join(directory, 'report.json');
const startedAt = performance.now();
const child = spawn(process.execPath, [mcp], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, AGENTBRIDGE_BASELINE_FILE: reportPath },
});
const stderr = [];
child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

const exit = await waitForExit(child, 15_000);
const startupMs = Math.round(performance.now() - startedAt);
const report = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, 'utf8'))
  : null;
const result = {
  generatedAt: new Date().toISOString(),
  node: process.versions.node,
  startupMs,
  peakRssMb: report ? Number((report.rssBytes / 1024 / 1024).toFixed(1)) : null,
  heapUsedMb: report ? Number((report.heapUsedBytes / 1024 / 1024).toFixed(1)) : null,
  installTargetMb: 100,
  processRssTargetMb: 80,
  exitCode: exit.code,
  signal: exit.signal,
  stderr: stderr.join('').trim(),
};
console.log(JSON.stringify(result, null, 2));
try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* keep diagnostics; never spawn a cleanup loop */ }
if (exit.code !== 0 || !report) process.exitCode = 1;

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      processHandle.kill();
      finish({ code: null, signal: 'timeout' });
    }, timeoutMs);
    processHandle.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    processHandle.once('close', (code, signal) => finish({ code, signal }));
  });
}
