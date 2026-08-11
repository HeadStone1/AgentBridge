import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('app-server')) {
  if (args.includes('--help')) {
    console.log('codex app-server runtime-failure fixture');
    process.exit(0);
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === 'initialize' || request.method === 'thread/start') {
      write(request.id, request.method === 'thread/start' ? { thread: { id: 'thread_runtime_failure' } } : {});
    } else if (request.method === 'turn/start') {
      writeError(request.id, 'temporary App Server failure');
    } else {
      write(request.id, {});
    }
  }
} else {
  if (args.includes('--version')) {
    console.log('codex 0.0.0-runtime-failure');
    process.exit(0);
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread_cli_fallback' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'cli fallback response' } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}

function write(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`);
}
