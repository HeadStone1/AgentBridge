# AgentBridge deployment guide for AI agents

[简体中文](README.md) | [English](README.en.md) | [Español](README.es.md) | **AI deployment guide**

This document is written for an AI coding agent that has been asked to deploy, upgrade, diagnose, or remove AgentBridge on a user's machine. Preserve the user's data and existing MCP configuration. Do not report success until the verification gates below pass.

## Mission and invariants

AgentBridge is a local stdio MCP server connecting Claude Code with either Codex App's bundled App Server or a standalone Codex CLI. It keeps each project's discussions in `<project>/.agentbridge/agentbridge.sqlite`.

The following conditions are mandatory:

1. Claude Code, the selected Codex provider, AgentBridge, and the project must be accessible inside the same operating-system environment. A Codex App on the VM host cannot act as the local App Server for AgentBridge running inside the guest VM.
2. Claude Code must be installed and authenticated. Claude Desktop alone is not the supported Claude provider.
3. Codex must be either:
   - an installed and authenticated Codex App; a separate Codex CLI installation is not required, or
   - an installed and authenticated standalone Codex CLI.
4. Run `setup` separately for every project. One global installation can serve many projects, but configuration and SQLite state are project-scoped.
5. Use absolute project paths. Do not assume the MCP process working directory identifies the project.
6. Choose exactly one installation method: GitHub Release, npm, or source. Do not mix launchers from different methods.
7. Do not delete a source checkout, project database, configuration, or system installation without explicit user approval.

## Ask or discover before changing anything

Collect these facts. Prefer read-only discovery over asking the user when the answer is available locally.

- Operating system and architecture.
- Absolute project path and whether it is writable.
- Existing AgentBridge installation method and version, if any.
- Whether Claude Code is installed and authenticated.
- Whether the intended Codex provider is Codex App or standalone Codex CLI.
- Whether Codex App and AgentBridge are inside the same VM or machine.
- Whether the project already contains `.agentbridge` or `.codex/config.toml`.
- Whether `~/.claude.json` already contains unrelated MCP servers that must be preserved.

Never copy authentication tokens into project files or chat output. AgentBridge uses the providers' existing local authentication.

## Select an installation method

| Situation | Method | Runtime requirement |
|---|---|---|
| Ordinary user, Codex App user, or source-independent deployment | GitHub Release, preferred | Bundled Node runtime |
| Developer already managing Node.js | Global npm package | Node.js 22.13+ |
| Contributor modifying AgentBridge itself | Source checkout | Git, npm, Node.js 22.13+ |

Release installs into the user's `~/.agentbridge` program directory. After installation it does not depend on the downloaded archive or a Git checkout.

## GitHub Release deployment

Download the matching asset and `SHA256SUMS.txt` from the latest GitHub Release.

| System | Asset |
|---|---|
| Windows 10/11 x64 | `AgentBridge-v<VERSION>-win32-x64.zip` |
| Linux x64 | `AgentBridge-v<VERSION>-linux-x64.tar.gz` |
| macOS Apple Silicon | `AgentBridge-v<VERSION>-darwin-arm64.tar.gz` |

Linux ARM64 and Intel macOS packages are not currently published. Use npm or source on those targets.

### Windows Release

From the directory containing the archive and checksum file:

```powershell
$asset = 'AgentBridge-v<VERSION>-win32-x64.zip'
$line = Get-Content -LiteralPath '.\SHA256SUMS.txt' |
  Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" }
if (-not $line) { throw "Checksum entry is missing for $asset" }
$expected = (($line -split '\s+')[0]).ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath ".\$asset" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA-256 verification failed; do not install' }
Expand-Archive -LiteralPath ".\$asset" -DestinationPath '.\agentbridge-release'
```

Enter the extracted package directory, then run:

```powershell
$project = 'C:\absolute\path\to\project'
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw 'Project does not exist' }
Unblock-File -LiteralPath '.\install.ps1'
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProjectPath $project
```

Expected final messages include the installed version, a launcher under `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`, a full-uninstall command, and a reminder to restart both clients.

### Linux Release

```bash
asset='AgentBridge-v<VERSION>-linux-x64.tar.gz'
grep "  $asset$" SHA256SUMS.txt | sha256sum -c -
tar -xzf "$asset"
cd "${asset%.tar.gz}"
chmod +x install.sh
./install.sh /absolute/path/to/project
~/.agentbridge/bin/agentbridge doctor /absolute/path/to/project
```

### macOS Apple Silicon Release

```bash
asset='AgentBridge-v<VERSION>-darwin-arm64.tar.gz'
expected=$(awk -v file="$asset" '$2 == file {print $1}' SHA256SUMS.txt)
actual=$(shasum -a 256 "$asset" | awk '{print $1}')
test -n "$expected" && test "$actual" = "$expected" || exit 1
tar -xzf "$asset"
cd "${asset%.tar.gz}"
chmod +x install.sh
./install.sh /absolute/path/to/project
~/.agentbridge/bin/agentbridge doctor /absolute/path/to/project
```

If macOS quarantines a verified GitHub Release, show the user the exact Gatekeeper message and ask before changing quarantine attributes or security policy.

## npm deployment

Use this only when a stable Node.js 22.13+ installation is available:

```bash
node --version
npm install --global @headstone/agentbridge
agentbridge --version
agentbridge setup /absolute/path/to/project
agentbridge doctor /absolute/path/to/project
```

Do not use a one-shot `npx` command for persistent setup: the generated MCP configuration needs a stable executable path.

## Source deployment

Use source mode only for development:

```bash
git clone https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
npm ci
npm test
node packages/cli/dist/index.js setup /absolute/path/to/project
node packages/cli/dist/index.js doctor /absolute/path/to/project
```

Do not configure a normal user's clients to point at a temporary checkout if a source-independent Release install is intended.

## Configure every project

For each additional project, run the launcher belonging to the chosen installation method:

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" setup 'D:\absolute\project-b'
```

```bash
~/.agentbridge/bin/agentbridge setup /absolute/project-b
```

`setup` should preserve unrelated configuration while creating or updating:

- `<project>/.agentbridge/project.json`
- `<project>/.agentbridge/agentbridge.sqlite`
- `<project>/.codex/config.toml`
- the project's `mcpServers.agentbridge` entry in `~/.claude.json`
- `~/.agentbridge/projects.json`

After setup, fully quit and reopen Claude Code and Codex. Closing only a project window may not reload MCP configuration.

## Determine whether Codex App or Codex CLI is actually selected

Run `doctor` and parse its JSON. Do not decide based only on a process name, an application folder, or `codexAppDetected`.

### Codex App expected result

```json
{
  "providers": {
    "codexAppServer": true,
    "codexSelectedBackend": {
      "mode": "app-server",
      "source": "desktop"
    }
  }
}
```

Interpretation:

- `mode: "app-server"` means AgentBridge selected the Codex App Server protocol.
- `source: "desktop"` means it discovered the executable bundled with Codex App.
- `codexAppDetected` is only GUI-process diagnostic information. It does not prove that the App Server backend can start.
- A failing `codex --version` is not by itself a failure when the selected backend is `app-server` from `desktop`.

### Standalone Codex CLI expected result

```json
{
  "providers": {
    "codexSelectedBackend": {
      "mode": "cli",
      "source": "system"
    }
  }
}
```

Confirm that the selected command is the user's intended authenticated CLI. If the user requested App mode but doctor reports `cli`, do not silently call the installation successful. Follow `recommendations`, verify Codex App is installed in the same environment, and rerun doctor.

The backend can be constrained using `AGENTBRIDGE_CODEX_MODE=app-server` or `AGENTBRIDGE_CODEX_MODE=cli`, but do not overwrite the user's desired selection without explaining the effect.

## Four verification gates

### Gate 1: doctor

Run the installed launcher:

```powershell
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" doctor 'C:\absolute\project'
```

```bash
agentbridge doctor /absolute/project
```

Require:

- top-level `ok: true`;
- `node.ok`, `installation.valid`, `project.initialized`, `project.metadataValid`, and `registry.registered` are true;
- `database.ok`, `configuration.claude.ok`, and `configuration.codex.ok` are true;
- `providers.claudeCli` is true;
- `providers.codexSelectedBackend` matches the intended App or CLI route.

For Release and npm installations, `installation.sourceIndependent` should be true. Source development mode is expected to report false.

### Gate 2: configuration files

Verify that both clients point to the same absolute database and project path.

Windows:

```powershell
$project = (Resolve-Path -LiteralPath 'C:\absolute\project').Path
Select-String -LiteralPath "$env:USERPROFILE\.claude.json" -Pattern 'agentbridge'
Select-String -LiteralPath "$project\.codex\config.toml" -Pattern 'mcp_servers.agentbridge|AGENTBRIDGE_AGENT|AGENTBRIDGE_PROJECT_PATH|AGENTBRIDGE_DB_PATH'
```

Unix:

```bash
grep -n 'agentbridge' ~/.claude.json
grep -nE 'mcp_servers.agentbridge|AGENTBRIDGE_AGENT|AGENTBRIDGE_PROJECT_PATH|AGENTBRIDGE_DB_PATH' /absolute/project/.codex/config.toml
```

Claude must use `AGENTBRIDGE_AGENT=claude`; Codex must use `AGENTBRIDGE_AGENT=codex`. Both must use the same `AGENTBRIDGE_DB_PATH`.

### Gate 3: client MCP tool lists

After a full restart, inspect the MCP/Tools/Integrations view in both clients. Require an `agentbridge` server and these seven tools:

- `ask_peer`
- `reply_peer`
- `get_discussion`
- `list_discussions`
- `close_discussion`
- `cancel_discussion`
- `retry_discussion`

Doctor validates files and launchability; it cannot prove an already running GUI has reloaded the MCP server.

### Gate 4: real bidirectional calls

Ask Claude Code to call `ask_peer` toward Codex, then ask Codex to call `ask_peer` toward Claude. Finally run:

```bash
agentbridge status /absolute/project
```

Only report end-to-end success after both directions work and the discussions appear in status.

## Common failures and fixes

| Symptom | Likely cause | Corrective action |
|---|---|---|
| Project path not found | Relative, misspelled, or host-only path | Resolve and use a real absolute path inside the same OS/VM |
| Host Codex App not found in guest VM | Cross-VM local-process boundary | Install/log in to Codex inside the VM or use a CLI installed inside the VM |
| `Cannot find module 'node:sqlite'` | Node is older than 22.13 | Upgrade Node, or use the Release package with bundled runtime |
| PowerShell script is blocked | Download quarantine / execution policy | Verify SHA-256, run `Unblock-File`, then use the documented Bypass invocation |
| `Permission denied` for `install.sh` | Executable bit missing | Run `chmod +x install.sh` after checksum verification |
| Access denied under `~/.agentbridge` | User profile permissions or security software | Check ownership and controlled-folder access; avoid system-wide/admin directories |
| Launcher missing after install | Package moved incompletely or stale install | Check `~/.agentbridge/current` and `~/.agentbridge/bin`; reinstall the verified package |
| `doctor.ok` is false | One or more checks failed | Execute `recommendations` in order and rerun doctor; do not ignore the top-level result |
| Codex App is open but App Server is unavailable | GUI presence is not backend capability | Inspect `codexAppServer` and `codexSelectedBackend`; verify the App installation and login |
| App requested but `mode=cli` | Auto-discovery selected system CLI | Verify App is local to this machine/VM or constrain the intended mode, then rerun doctor |
| CLI requested but `mode=app-server` | Auto mode preferred Desktop | Set the intended configuration deliberately and rerun setup/doctor |
| Config exists but tools are absent | Client has not reloaded MCP or launch command fails | Fully quit/restart client and inspect its MCP startup logs |
| Claude and Codex see different discussions | Different project/database paths | Compare both `AGENTBRIDGE_DB_PATH` values and rerun setup for the correct project |
| Wrong peer identity | Missing or reversed `AGENTBRIDGE_AGENT` | Claude must be `claude`; Codex must be `codex` |
| Second project replaced the first | Old global-only configuration or wrong setup | Upgrade, run setup for every project, verify Claude project scope and project-local Codex config |
| `database is locked` | Long-running writer, copied live WAL database, or network filesystem | Stop clients, keep DB local, retry; back up the whole `.agentbridge` directory only when idle |
| `PEER_BUSY` or peer unavailable | Provider is busy, unauthenticated, or backend failed | Complete provider login, inspect doctor, wait for active work to finish, then use `retry_discussion` |
| Codex returns no agent message | Provider/App Server protocol or authentication error | Re-run doctor, test the selected provider directly, inspect client logs, then retry |
| Update leaves stale MCP command | Setup was not rerun or mixed install methods | Run the current launcher's setup again and remove stale entries only after backing up configs |
| Git `dubious ownership` in source mode | Repository owner differs from current user | Add only the verified repository path to Git's safe-directory list; never whitelist an untrusted tree |
| Old archive behaves differently | Obsolete v0.3 package or cached asset | Remove the obsolete archive and obtain the versioned asset plus matching checksum from Releases |
| Doctor passes but collaboration fails | Doctor is not a live client handshake | Complete Gates 3 and 4 and inspect each client's MCP/provider logs |

## Updates and rollback

Release installation:

```bash
agentbridge version
agentbridge update
agentbridge update --install
agentbridge rollback
```

`update` is read-only. `update --install` downloads the matching Release, verifies `SHA256SUMS.txt`, installs a version under `~/.agentbridge/versions`, and switches the current launcher. It preserves project configuration and SQLite data. Rerun `setup` for registered projects and restart both clients after updating.

npm installation:

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup /absolute/project
agentbridge doctor /absolute/project
```

Source installation:

```bash
git status
git pull --ff-only origin main
npm ci
npm test
node packages/cli/dist/index.js setup /absolute/project
```

Never use a destructive Git reset to hide unknown local changes.

## Backup and uninstall

Before deleting discussion data, stop both clients and copy the whole `<project>/.agentbridge` directory, including any SQLite WAL/SHM files.

Remove one project only:

```bash
agentbridge uninstall /absolute/project --yes
```

This removes that project's AgentBridge MCP entries and `.agentbridge` data, but keeps the installed program and other projects.

Remove every registered project and the Release/npm program:

```bash
agentbridge uninstall-all --yes --remove-program
```

The full uninstall intentionally requires both confirmation flags. Source mode does not delete the Git checkout. If cleanup fails for any project, the program is retained so the failure can be repaired and retried.

## Required completion report

Return a concise report containing:

```text
AgentBridge version:
Installation method and launcher:
Operating system / architecture:
Project absolute path:
Claude provider status:
Requested Codex route: App or CLI
Selected Codex backend mode/source:
Doctor top-level ok:
Claude config verified:
Codex config verified:
Seven MCP tools visible in Claude:
Seven MCP tools visible in Codex:
Claude -> Codex real call:
Codex -> Claude real call:
Backup or files changed:
Remaining warnings:
```

Do not collapse “Codex App is installed,” “App Server was selected,” and “the live Codex client loaded AgentBridge” into one claim. They are three separate facts.

## License constraint for deployment agents

AgentBridge v0.5.0 and later is under `PolyForm-Noncommercial-1.0.0`. The public license does not grant commercial use. If the requested deployment appears commercial, stop before deploying and direct the user to [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md). Historical releases through v0.4.2 retain their Apache-2.0 license. See [LICENSE_HISTORY.md](LICENSE_HISTORY.md).
