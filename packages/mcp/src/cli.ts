import { AuditService } from '@agentbridge/audit';
import { CollaborationService } from '@agentbridge/collaboration';
import { Storage } from '@agentbridge/storage';
import { runServer } from './server.js';
import type { AgentType } from '@agentbridge/protocol';
import { ClaudeConnector, CodexAppServerConnector, CodexConnector } from '@agentbridge/connectors';

const agentType: AgentType = process.env.AGENTBRIDGE_AGENT === 'codex' ? 'codex' : 'claude';
const storage = new Storage();
const audit = new AuditService(storage);
storage.recoverExpiredSessionLeases();
const recoveryAgeMs = Number.parseInt(process.env.AGENTBRIDGE_RECOVERY_MAX_AGE_MS ?? '', 10);
const recovered = storage.recoverStaleDiscussions(
  Number.isInteger(recoveryAgeMs) && recoveryAgeMs > 0 ? recoveryAgeMs : undefined,
);
for (const discussion of recovered) {
  audit.log({
    traceId: discussion.traceId,
    discussionId: discussion.id,
    action: 'discussion.recovered',
    agent: 'system',
    metadata: { status: discussion.status, reason: 'stale_process_recovery' },
  });
}
const codexConnector = process.env.AGENTBRIDGE_CODEX_APP_COMMAND
  ? new CodexAppServerConnector({ command: process.env.AGENTBRIDGE_CODEX_APP_COMMAND })
  : new CodexConnector({
      command: process.env.AGENTBRIDGE_CODEX_COMMAND ?? process.env.CODEX_CLI_PATH,
      model: process.env.AGENTBRIDGE_CODEX_MODEL,
    });
const collaboration = new CollaborationService(
  storage,
  audit,
  {},
  {
    claude: new ClaudeConnector({ command: process.env.AGENTBRIDGE_CLAUDE_COMMAND }),
    codex: codexConnector,
  },
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  storage.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Test-only guard: an interrupted harness must not leave an MCP child alive
// indefinitely. Production runs leave this unset.
const testLifetimeMs = Number.parseInt(process.env.AGENTBRIDGE_TEST_MAX_LIFETIME_MS ?? '', 10);
if (Number.isInteger(testLifetimeMs) && testLifetimeMs > 0) {
  setTimeout(shutdown, testLifetimeMs);
}

if (process.env.AGENTBRIDGE_BASELINE_FILE) {
  writeFileSync(process.env.AGENTBRIDGE_BASELINE_FILE, JSON.stringify({
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    node: process.versions.node,
  }));
  shutdown();
}

const exitAfterToolCalls = Number.parseInt(process.env.AGENTBRIDGE_TEST_EXIT_AFTER_TOOL_CALLS ?? '', 10);
await runServer(storage, collaboration, {
  agentType,
  ...(Number.isInteger(exitAfterToolCalls) && exitAfterToolCalls > 0 ? { exitAfterToolCalls } : {}),
});
import { writeFileSync } from 'node:fs';
