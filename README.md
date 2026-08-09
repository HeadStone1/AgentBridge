# AgentBridge

AgentBridge is the local-first MCP collaboration core for Claude Code and
Codex. Each host starts its own short-lived stdio MCP process; both processes
can share one project SQLite database.

## Current v0.3 implementation

- SQLite WAL storage using Node's built-in `node:sqlite` (`StoragePort` keeps a
  future cloud adapter isolated).
- Discussion state machine, append-only audit events, provider session
  registry, project/provider leases, retry budget, timeout and message budget.
- MCP tools: `ask_peer`, `reply_peer`, `get_discussion`, `close_discussion`,
  `cancel_discussion`, `retry_discussion`, and `list_discussions`.
- Claude CLI session resume, Codex CLI `exec --json` / `exec resume`, and an
  explicit Codex App Server stdio adapter for installations that provide an
  App Server executable but no Codex CLI.
- CLI management: `init`, `setup`, `status`, `doctor`, `register-session`,
  `uninstall`, and `update` capability reporting.
- Incremental Claude JSON and Codex TOML MCP configuration with a backup before
  a change.
- Safe uninstall that removes only AgentBridge MCP entries and preserves other
  provider configuration.
- Dual SQLite-owner regression test and a resource baseline script.

## Development

Requires Node.js 22.5 or newer because the storage layer uses `node:sqlite`.

```bash
npm install
npm test
npm run build
npm run baseline
npm run release
```

`npm run release` creates bundled Node artifacts in `release/`:
`agentbridge-mcp.mjs` and `agentbridge-cli.mjs`. A signed native Windows EXE
and automatic updater are still distribution work; these bundles still require
the Node runtime.

## Setup and MCP

After building, `setup` initializes `.agentbridge` and updates the configured
provider MCP files incrementally:

```powershell
node packages/cli/dist/index.js setup .
node packages/cli/dist/index.js doctor .
node packages/cli/dist/index.js status .
```

The default files are `~/.claude.json` and `~/.codex/config.toml`. Use
`--no-config` to initialize project state only, or pass
`--claude-config`/`--codex-config` for test or managed locations. Existing
provider entries are preserved and the previous file is saved as
`*.agentbridge.bak` before a change.

The default database is `.agentbridge/agentbridge.sqlite`. Set
`AGENTBRIDGE_DB_PATH` to override it; tests use `:memory:` or temporary files.
`AGENTBRIDGE_CODEX_COMMAND` and `AGENTBRIDGE_CODEX_MODEL` apply to the Codex
CLI connector only. For a Desktop/App Server installation, pass
`--codex-app-command PATH` to `setup`; the configured command must support
`app-server --stdio`. The adapter starts a bounded local App Server child and
does not inject into the already-running Desktop UI process.

## Known boundaries

The real provider acceptance still depends on the installed Claude/Codex
provider and account. `doctor` detects a running Codex Desktop App for
diagnostics; the App Server adapter requires an explicit executable path and
does not claim to attach to the Desktop UI's private process channel.

Cloud deployment, PostgreSQL/Redis, resident HTTP service, strict mode, busy
queue, crash recovery, signed EXE packaging, and automatic updates remain
later phases of v0.3/v0.4.
