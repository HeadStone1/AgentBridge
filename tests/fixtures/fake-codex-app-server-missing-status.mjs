import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('codex app-server missing-status fixture');
  process.exit(0);
}

const threadId = 'thread_fake_missing_status';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    write(request.id, {});
  } else if (request.method === 'thread/start') {
    write(request.id, { thread: { id: threadId } });
  } else if (request.method === 'turn/start') {
    const turnId = 'turn_fake_missing_status';
    write(request.id, { turn: { id: turnId } });
    notify('item/agentMessage/delta', { threadId, turnId, delta: 'content before invalid completion' });
    notify('turn/completed', { threadId, turnId, turn: { id: turnId } });
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
