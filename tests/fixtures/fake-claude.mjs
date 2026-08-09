const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}

const resumeIndex = args.indexOf('--resume');
const sessionIndex = args.indexOf('--session-id');
const sessionId = resumeIndex >= 0
  ? args[resumeIndex + 1]
  : sessionIndex >= 0
    ? args[sessionIndex + 1]
    : undefined;

console.log(JSON.stringify({
  result: resumeIndex >= 0 ? 'resumed response' : 'initial response',
  session_id: sessionId,
}));
