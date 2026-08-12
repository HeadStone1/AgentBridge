import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);

for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.method === 'initialize') write(request.id, { protocolVersion: '2025-06-18', capabilities: {} });
  else if (request.method === 'thread/start') write(request.id, { thread: { id: 'thread_request_test' } });
  else if (request.method === 'turn/start') {
    write(request.id, { turn: { id: 'turn_request_test' } });
    process.stdout.write(`${JSON.stringify({ id: 900, method: 'item/requestApproval', params: { reason: 'test' } })}\n`);
  } else if (request.id === 900 && request.result?.decision === 'decline') {
    notify('item/agentMessage/delta', { threadId: 'thread_request_test', turnId: 'turn_request_test', delta: 'request handled' });
    notify('turn/completed', { threadId: 'thread_request_test', turnId: 'turn_request_test', turn: { status: 'completed' } });
  }
}
