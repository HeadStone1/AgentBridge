# AgentBridge

[简体中文](README.md) | **English** | [Español](README.es.md) | [Guide for AI deployment agents](README.ai.md)

AgentBridge is a local-first MCP collaboration bridge that lets Claude Code and OpenAI Codex ask each other questions, reply, retry, reach agreement, and persist discussion state in a project-local SQLite database.

> Current development version: v0.6.0. AgentBridge is registered globally once; each client session then detects the active project and keeps its SQLite data inside that project.

> Current source verification: the UTF-8 check, TypeScript build, and all 96 tests across 17 test files pass. Native provider sessions resume only when they are explicitly bound to the same discussion; a new discussion never inherits another discussion's session or an unbound historical session. These automated checks do not replace live provider validation: claim real bidirectional communication only after successful Claude → Codex and Codex → Claude `ask_peer` calls.

## Install first, read details second

### Choose one method

| User | Recommended method | Requirement |
|---|---|---|
| Most users and Codex App users | GitHub Release package | No separate Node.js installation |
| Developers already using Node.js | Global npm package | Node.js 22.13+ |
| AgentBridge contributors | Source checkout | Git, npm, Node.js 22.13+ |

Do not mix Release, npm, and source commands. Download ordinary user builds from [GitHub Releases](https://github.com/HeadStone1/AgentBridge/releases/latest).

### Prerequisites

- Claude Code, Codex, AgentBridge, and the target project must be on the same machine or inside the same VM. A host-machine Codex App cannot provide a local App Server to AgentBridge inside a guest VM.
- Install and authenticate Claude Code. Claude Desktop by itself is not the supported Claude provider.
- Install and authenticate either Codex App or standalone Codex CLI.
- Codex App users do not need to install Codex CLI separately.
- Use an existing writable absolute project path.

### GitHub Release installation

Download the package matching your platform plus `SHA256SUMS.txt`:

- Windows x64: `AgentBridge-v0.6.0-win32-x64.zip`
- Linux x64: `AgentBridge-v0.6.0-linux-x64.tar.gz`
- macOS Apple Silicon: `AgentBridge-v0.6.0-darwin-arm64.tar.gz`

Linux ARM64 and Intel macOS currently require npm or source installation.

Windows PowerShell, after verifying the archive against `SHA256SUMS.txt` and extracting it:

```powershell
Unblock-File -LiteralPath '.\install.ps1'
powershell -ExecutionPolicy Bypass -File .\install.ps1
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" doctor
```

Linux/macOS, after verifying and extracting the archive:

```bash
chmod +x install.sh
./install.sh
~/.agentbridge/bin/agentbridge doctor
```

The installer runs setup and doctor, then prints the permanent launcher and full-uninstall command.

### npm installation

The npm package is [`@headstone/agentbridge`](https://www.npmjs.com/package/@headstone/agentbridge).

```bash
node --version
npm install --global @headstone/agentbridge
agentbridge --version
agentbridge setup
agentbridge doctor
```

Use Node.js 22.13 or newer. Avoid one-shot `npx` setup because MCP configuration needs a stable program path.

### Source installation

```bash
git clone https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
npm ci
npm test
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js doctor
```

Source mode is for development. Prefer a Release package for a source-independent user installation.

## Codex App versus Codex CLI

Run doctor and inspect `providers.codexSelectedBackend`. Do not infer the backend only from whether the GUI is open.

Codex App should report:

```json
{
  "mode": "app-server",
  "source": "desktop"
}
```

Standalone Codex CLI should report:

```json
{
  "mode": "cli",
  "source": "system"
}
```

`codexAppDetected` only indicates whether the GUI process was observed. It does not prove App Server availability. When App mode is intended, `codexAppServer` must be true and the selected backend must be `app-server` from `desktop`.

## Register once, use every project

Run `agentbridge setup` only once. It writes one user-scoped server to `~/.claude.json` and one global server to `~/.codex/config.toml`; it does not pin a project path, database path, or Codex `cwd`.

After restarting both clients, open any project normally. The first AgentBridge tool call binds that MCP process to the active project using Claude's project environment, MCP roots, or the client's working directory. It then creates `<project>/.agentbridge/agentbridge.sqlite`. Different projects remain isolated without another setup command. If the host supplies no safe project context, pass the absolute `projectPath` to the first `ask_peer` or `list_discussions` call.

## Verify the complete connection

Doctor is necessary, but it cannot prove that an already running client reloaded MCP. Complete all four checks.

1. Run `agentbridge doctor /absolute/project`. Require top-level `ok: true`, valid installation/project/database/configuration checks, `providers.claudeCli: true`, and the intended Codex backend.
2. Inspect `~/.claude.json` and `~/.codex/config.toml`. Claude must use `AGENTBRIDGE_AGENT=claude`; Codex must use `AGENTBRIDGE_AGENT=codex`; neither global entry should pin `AGENTBRIDGE_PROJECT_PATH`, `AGENTBRIDGE_DB_PATH`, or Codex `cwd`.
3. Restart both clients and confirm the `agentbridge` MCP server exposes seven tools: `ask_peer`, `reply_peer`, `get_discussion`, `list_discussions`, `close_discussion`, `cancel_discussion`, and `retry_discussion`.
4. Perform a real Claude-to-Codex `ask_peer` call and a real Codex-to-Claude call, then verify them with `agentbridge status /absolute/project`.

## Main commands

| Command | Purpose |
|---|---|
| `setup [path]` | Configure both MCP clients globally; an optional path only pre-initializes one project |
| `doctor [path]` | Diagnose installation, project, DB, configs, launchers, and providers |
| `status [path]` | Show sessions, discussions, and metrics |
| `version` | Show AgentBridge version |
| `update` | Check stable GitHub Releases without modifying files |
| `update --install` | Download, verify, and install the latest compatible Release |
| `rollback` | Select the previously installed Release version |
| `uninstall [path] --yes` | Remove one project's data while keeping global MCP registration |
| `uninstall-all --yes --remove-program` | Remove all registered projects and the Release/npm program |

Windows Release users call `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`; Unix Release users call `~/.agentbridge/bin/agentbridge`.

## Updates

Release users:

```bash
agentbridge update
agentbridge update --install
agentbridge setup
agentbridge doctor
```

npm users:

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup
agentbridge doctor
```

Restart both clients after updating. Release updates keep versioned program files and support `agentbridge rollback`.

## Backup and uninstall

Stop both clients before copying the entire `<project>/.agentbridge` directory. SQLite may use `-wal` and `-shm` files, so do not back up only the main database during active writes.

```bash
agentbridge uninstall /absolute/project --yes
```

This removes only that project's state and MCP entries. It does not remove the program or other projects.

```bash
agentbridge uninstall-all --yes --remove-program
```

This removes every registered AgentBridge project and the Release/npm installation. A source checkout is never deleted automatically.

## Common problems

- `Cannot find module 'node:sqlite'`: upgrade to Node.js 22.13+, or use the Release package.
- App is open but doctor selects CLI: GUI detection is not App Server capability; verify local App installation/login and inspect `codexSelectedBackend`.
- Config is present but tools are missing: fully quit both clients and inspect their MCP startup errors.
- Claude and Codex see different discussions: confirm both clients opened the same absolute project root. Start a fresh client task/window after switching projects; if project detection is unavailable, pass the same absolute `projectPath` on the first `ask_peer` or `list_discussions` call.
- Wrong peer identity: Claude must have `AGENTBRIDGE_AGENT=claude`, Codex must have `AGENTBRIDGE_AGENT=codex`.
- `database is locked`: keep the database on a local filesystem, stop active writers, and do not copy only part of a live SQLite WAL database.
- `PEER_BUSY`: verify provider login/backend health, wait for current work, then call `retry_discussion`.
- PowerShell blocks installation: verify SHA-256 first, then use the documented `Unblock-File` and Bypass command.
- `Permission denied` on Unix: run `chmod +x install.sh` on the verified package.
- A new project has no tools: global `setup` is required only once. Fully restart the client, open the project normally, and inspect MCP startup errors; if the first tool call cannot identify the root, pass an absolute `projectPath`.

For an exhaustive automation-oriented runbook and troubleshooting matrix, see [README.ai.md](README.ai.md). The complete Chinese manual remains in [README.md](README.md).

## Security

AgentBridge does not bypass Claude permissions. Codex defaults to a read-only sandbox. Project discussion data is stored unencrypted in `.agentbridge/agentbridge.sqlite`; protect it according to the project's sensitivity. Do not publish provider configuration backups because they may contain unrelated MCP environment variables or credentials.

## License

AgentBridge v0.5.0 and later is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). The public license permits noncommercial purposes but does not grant commercial use to anyone other than the copyright holder. Obtain a separate written license from HeadStone1 before commercial use; see [commercial licensing guidance](COMMERCIAL_LICENSE.md).

Published versions through v0.4.2 remain under Apache-2.0. See [license history](LICENSE_HISTORY.md). Third-party components retain their own licenses.
