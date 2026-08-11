import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (!args.includes('app-server')) {
  if (args.includes('--version')) console.log('codex 0.0.0-post-turn-failure');
  process.exit(0);
}

if (args.includes('--help')) {
  console.log('codex app-server post-turn-failure fixture');
  process.exit(0);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') write(request.id, {});
  else if (request.method === 'thread/start') write(request.id, { thread: { id: 'thread_post_turn_failure' } });
  else if (request.method === 'turn/start') {
    write(request.id, { turn: { id: 'turn_post_turn_failure' } });
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/failed',
      params: { turnId: 'turn_post_turn_failure', message: 'turn failed after provider accepted the request' },
    })}\n`);
  } else write(request.id, {});
}

function write(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
