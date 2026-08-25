# AgentBridge configuration

AgentBridge uses one configuration model for the MCP server, CLI, and the local UI.

## Files

- Global defaults: `~/.agentbridge/config.json` (or the directory selected by `AGENTBRIDGE_CONFIG_HOME`).
- Project overrides: `<project>/.agentbridge/config.json`.
- Discussion history remains in `<project>/.agentbridge/agentbridge.sqlite`.

Run `agentbridge ui` from a project directory to edit global defaults and the selected project override in one page. The page is a temporary `127.0.0.1` server and exits after the user closes it or after an idle timeout.

## Precedence

```text
program defaults < global config < project config < legacy AGENTBRIDGE_* environment overrides
```

Missing project fields inherit the global value. A project value of `null` is only accepted where the schema documents it as a special value, such as `discussion.maxDuration: null` for no overall wall-clock limit.

## Example

```json
{
  "version": 1,
  "invocation": {
    "autonomous": true
  },
  "discussion": {
    "maxDuration": "2h",
    "idleTimeout": "10m",
    "turnHardLimit": "1h",
    "maxTurns": 20
  },
  "session": {
    "retentionDays": 30,
    "archiveOnClose": false
  }
}
```

Duration strings use `ms`, `s`, `m`, `h`, and `d`. Operational watchdogs are capped below Node's native timer overflow boundary; `maxDuration: null` is the supported way to remove the overall discussion limit while turn, idle, and provider safety controls remain active.

## Autonomous invocation

`invocation.autonomous` is the authoritative user/project setting. When it is `false`, an `ask_peer` call must identify itself as `user_requested`; calls marked `autonomous` are rejected by the MCP server. Skill files describe discussion quality and turn-taking, but they do not override this configuration.

The MCP reloads global and project configuration before a new `ask_peer` operation. Legacy environment variables remain supported for compatibility and take precedence over JSON files.
