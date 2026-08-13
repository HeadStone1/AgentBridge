# AgentBridge deployment guide for AI agents

[简体中文](README.md) | [English](README.en.md) | [Español](README.es.md) | **AI deployment guide**

This document is written for an AI coding agent that has been asked to deploy, upgrade, diagnose, or remove AgentBridge on a user's machine. Preserve the user's data and existing MCP configuration. Do not report success until the verification gates below pass.

> Current v0.7.1 source verification must include the UTF-8 check, TypeScript build, complete test suite, and package smoke tests before release.

Windows note: the unified ChatGPT Desktop MSIX runtime is private to the package. AgentBridge distributions include the official `@openai/codex` CLI and launch its independent stdio App Server instead of attempting to attach to the GUI daemon.

## Mission and invariants

AgentBridge is a local stdio MCP server connecting Claude Code with either Codex App's bundled App Server or a standalone Codex CLI. It keeps each project's discussions in `<project>/.agentbridge/agentbridge.sqlite`.

The following conditions are mandatory:

1. Claude Code, the selected Codex provider, AgentBridge, and the project must be accessible inside the same operating-system environment. A Codex App on the VM host cannot act as the local App Server for AgentBridge running inside the guest VM.
2. Claude Code must be installed and authenticated. Claude Desktop alone is not the supported Claude provider.
3. Codex must be either:
   - an installed and authenticated Codex App; a separate Codex CLI installation is not required, or
   - an installed and authenticated standalone Codex CLI.
4. Run `setup` once to create user-scoped/global MCP entries. Do not repeat setup for every project.
5. Runtime data remains project-scoped. AgentBridge resolves the active root from an explicit/legacy project environment, `CLAUDE_PROJECT_DIR`, MCP `roots/list`, or the MCP process working directory. `ask_peer.projectPath` is the explicit fallback.
6. Choose exactly one installation method: GitHub Release, npm, or source. Do not mix launchers from different methods.
7. Do not delete a source checkout, project database, configuration, or system installation without explicit user approval.
8. Treat provider sessions as project-scoped AgentBridge resources. `auto/reuse` may resume only a live AgentBridge-owned session bound to the same project's collaboration session; `fresh` must remain isolated. Never reuse an unbound historical or superseded session.

## Ask or discover before changing anything

Collect these facts. Prefer read-only discovery over asking the user when the answer is available locally.

- Operating system and architecture.
- Absolute project path and whether it is writable.
- Existing AgentBridge installation method and version, if any.
- Whether Claude Code is installed and authenticated.
- Whether the intended Codex provider is Codex App or standalone Codex CLI.
- Whether Codex App and AgentBridge are inside the same VM or machine.
- Whether the project already contains `.agentbridge` or a legacy project-local `.codex/config.toml` entry.
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
Unblock-File -LiteralPath '.\install.ps1'
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Expected final messages include the installed version, a launcher under `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`, a full-uninstall command, and a reminder to restart both clients.

### Linux Release

```bash
asset='AgentBridge-v<VERSION>-linux-x64.tar.gz'
grep "  $asset$" SHA256SUMS.txt | sha256sum -c -
tar -xzf "$asset"
cd "${asset%.tar.gz}"
chmod +x install.sh
./install.sh
~/.agentbridge/bin/agentbridge doctor
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
./install.sh
~/.agentbridge/bin/agentbridge doctor
```

If macOS quarantines a verified GitHub Release, show the user the exact Gatekeeper message and ask before changing quarantine attributes or security policy.

## npm deployment

Use this only when a stable Node.js 22.13+ installation is available:

```bash
node --version
npm install --global @headstone/agentbridge
agentbridge --version
agentbridge setup
agentbridge doctor
```

Do not use a one-shot `npx` command for persistent setup: the generated MCP configuration needs a stable executable path.

## Source deployment

Use source mode only for development:

```bash
git clone https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
npm ci
npm test
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js doctor
```

Do not configure a normal user's clients to point at a temporary checkout if a source-independent Release install is intended.

## Global registration and automatic project isolation

`setup` writes exactly one user-scoped AgentBridge entry to `~/.claude.json` and one global entry to `~/.codex/config.toml`. These entries contain the provider identity and launcher only; they must not pin `AGENTBRIDGE_PROJECT_PATH`, `AGENTBRIDGE_DB_PATH`, or Codex `cwd`.

After setup, fully quit and reopen Claude Code and Codex, then open any writable project normally. On the first AgentBridge tool call in that client session, AgentBridge binds the stdio process to one project, creates `<project>/.agentbridge/project.json` and `<project>/.agentbridge/agentbridge.sqlite`, and adds the project to `~/.agentbridge/projects.json` for later cleanup. Another project receives another database.

Claude normally supplies `CLAUDE_PROJECT_DIR` and may support MCP roots. Codex normally launches global stdio MCP servers in the active workspace and may support MCP roots. If neither source identifies a safe project—for example, the process starts in the user's home directory—AgentBridge returns an error and creates no database. Retry `ask_peer` or `list_discussions` with an absolute `projectPath`; later calls in that MCP session reuse that binding.

When upgrading from v0.5.x, run the new `agentbridge setup` once. It migrates known project-scoped Claude/Codex entries to global entries while preserving unrelated MCP configuration and all project databases.

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

Verify the two global entries and confirm that neither pins a project/database path.

Windows:

```powershell
Select-String -LiteralPath "$env:USERPROFILE\.claude.json" -Pattern 'agentbridge'
Select-String -LiteralPath "$env:USERPROFILE\.codex\config.toml" -Pattern 'mcp_servers.agentbridge|AGENTBRIDGE_AGENT|AGENTBRIDGE_PROJECT_PATH|AGENTBRIDGE_DB_PATH|cwd'
```

Unix:

```bash
grep -n 'agentbridge' ~/.claude.json
grep -nE 'mcp_servers.agentbridge|AGENTBRIDGE_AGENT|AGENTBRIDGE_PROJECT_PATH|AGENTBRIDGE_DB_PATH|cwd' ~/.codex/config.toml
```

Claude must use `AGENTBRIDGE_AGENT=claude`; Codex must use `AGENTBRIDGE_AGENT=codex`. Neither entry should contain `AGENTBRIDGE_PROJECT_PATH`, `AGENTBRIDGE_DB_PATH`, or Codex `cwd`. The project database is selected dynamically and appears at `<project>/.agentbridge/agentbridge.sqlite` after the first tool call.

### Gate 3: client MCP tool lists

After a full restart, inspect the MCP/Tools/Integrations view in both clients. Require an `agentbridge` server and these eight tools:

- `ask_peer`
- `reply_peer`
- `get_discussion`
- `wait_discussion`
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
| Claude and Codex see different discussions | The two client sessions resolved different roots | Open the same project in both clients; if auto-detection failed, retry the first call with the same absolute `projectPath` |
| Wrong peer identity | Missing or reversed `AGENTBRIDGE_AGENT` | Claude must be `claude`; Codex must be `codex` |
| A second project reuses the first database | One long-lived MCP session was reused across workspace switching | Start a new client task/window for the new project; each MCP process intentionally binds once |
| Project cannot be determined safely | Host supplied neither project env nor MCP roots and started in a home/install directory | Open the workspace normally or pass absolute `projectPath` on `ask_peer`/`list_discussions`; no database is created on this error |
| `database is locked` | Long-running writer, copied live WAL database, or network filesystem | Stop clients, keep DB local, retry; back up the whole `.agentbridge` directory only when idle |
| `PEER_BUSY` or peer unavailable | Provider is busy, unauthenticated, or backend failed | Complete provider login, inspect doctor, wait for active work to finish, then use `retry_discussion` |
| Codex returns no agent message | Provider/App Server protocol or authentication error | Re-run doctor, test the selected provider directly, inspect client logs, then retry |
| Update leaves stale MCP command | Setup was not rerun or mixed install methods | Run the current launcher's setup again and remove stale entries only after backing up configs |
| Git `dubious ownership` in source mode | Repository owner differs from current user | Add only the verified repository path to Git's safe-directory list; never whitelist an untrusted tree |
| Old archive behaves differently | Obsolete v0.3 package or cached asset | Remove the obsolete archive and obtain the versioned asset plus matching checksum from Releases |
| Doctor passes but collaboration fails | Doctor is not a live client handshake | Complete Gates 3 and 4 and inspect each client's MCP/provider logs |
| Many duplicate Provider sessions | A new discussion was created while the previous dispatch was pending | Reuse its `discussionId` and call `wait_discussion`; optionally enable native archival on close |

## Updates and rollback

Release installation:

```bash
agentbridge version
agentbridge update
agentbridge update --install
agentbridge rollback
```

`update` is read-only. `update --install` downloads the matching Release, verifies `SHA256SUMS.txt`, installs a version under `~/.agentbridge/versions`, and switches the current launcher. It preserves project data. Run `agentbridge setup` once after an upgrade that changes MCP registration, then restart both clients.

npm installation:

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup
agentbridge doctor
```

Source installation:

```bash
git status
git pull --ff-only origin main
npm ci
npm test
node packages/cli/dist/index.js setup
```

Never use a destructive Git reset to hide unknown local changes.

## v0.7 discussion controls

`setup` installs four managed Skills into the Claude and Codex user Skill locations: `agentbridge-collaboration` for routing/lifecycle, `agentbridge-peer-review` for bounded finding-driven reviews, `agentbridge-debug` for reproducible root-cause work, and `agentbridge-decision-debate` for high-impact tradeoff debates. It must not overwrite a custom or modified same-name Skill.

`ask_peer.mode` accepts `review`, `discussion`, or `deep-discussion`, with default successful-response ceilings of 3, 12, and 20. An explicit `maxTurns` overrides the mode default but remains a safety ceiling rather than a target. Each peer response must end in one exact convergence signal; AgentBridge persists it as `lastSignal` and pauses on `NEEDS_USER_DECISION`. Use `wait_discussion` for bounded SQLite-backed long polling; a wait timeout never changes discussion status.

Discussion records are permanent by default. `agentbridge cleanup <project> --older-than-days N` previews eligible terminal rows; `--yes` performs the transaction. `AGENTBRIDGE_DISCUSSION_RETENTION_DAYS` enables opt-in startup cleanup, and `AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE=1` enables best-effort native archival. Tests and automation must set a temporary `AGENTBRIDGE_SKILL_HOME` and must never write real Claude/Codex user directories.

## Backup and uninstall

Before deleting discussion data, stop both clients and copy the whole `<project>/.agentbridge` directory, including any SQLite WAL/SHM files.

Remove one project only:

```bash
agentbridge uninstall /absolute/project --yes
```

This removes only that project's `.agentbridge` data and cleanup-registry record. It intentionally keeps the global MCP entries, installed program, and other projects working.

Remove every registered project and the Release/npm program:

```bash
agentbridge uninstall-all --yes --remove-program
```

Full uninstall removes the global MCP entries, every tracked project's local data, and then the installed program. It intentionally requires both confirmation flags. Source mode does not delete the Git checkout. If cleanup fails for any project, the program is retained so the failure can be repaired and retried.

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
