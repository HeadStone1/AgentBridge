const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('codex 0.0.0-test');
  process.exit(0);
}

const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'thread_fake_codex';

if (resumeIndex < 0) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
}
console.log(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message',
  text: resumeIndex >= 0 ? 'resumed codex response' : 'initial codex response',
} }));
console.log(JSON.stringify({ type: 'turn.completed' }));
