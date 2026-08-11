import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('codex app-server failure fixture');
  process.exit(0);
}

console.error('simulated provider diagnostic');

const threadId = 'thread_fake_failure';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    write(request.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
  } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    write(request.id, { thread: { id: threadId } });
  } else if (request.method === 'turn/start') {
    write(request.id, { turn: { id: 'turn_fake_failure' } });
    notify('turn/completed', {
      threadId,
      turnId: 'turn_fake_failure',
      status: 'failed',
      message: 'simulated App Server turn failure',
    });
  } else {
    write(request.id, {});
  }
}

function write(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
