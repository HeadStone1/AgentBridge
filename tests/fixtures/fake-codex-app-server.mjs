import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('codex app-server test fixture');
  process.exit(0);
}
if (process.env.AGENTBRIDGE_PEER_INVOCATION !== '1') {
  console.error('missing AGENTBRIDGE_PEER_INVOCATION');
  process.exit(3);
}

const threadId = 'thread_fake_app_server';
let turnNumber = 0;
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
    turnNumber += 1;
    const turnId = `turn_fake_${turnNumber}`;
    write(request.id, { turn: { id: turnId } });
    notify('item/agentMessage/delta', { threadId, turnId, delta: `app response ${turnNumber}` });
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', text: `app response ${turnNumber}` },
    });
    notify('turn/completed', { threadId, turnId, turn: { id: turnId, status: 'completed' } });
  } else if (request.method === 'thread/archive') {
    write(request.id, {});
  } else if (request.method === 'turn/interrupt') {
    write(request.id, {});
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
