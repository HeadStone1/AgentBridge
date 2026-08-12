---
name: agentbridge-collaboration
description: Coordinate structured peer discussions between Claude Code and Codex through AgentBridge MCP. Use when the user asks to consult, discuss with, obtain a second opinion from, or continue a review with the other coding agent, or when an existing AgentBridge discussion must be resumed, waited on, retried, or closed.
---

# AgentBridge collaboration

Use AgentBridge as a bounded collaboration channel with a project-scoped provider session. It is not an open-ended chat, but separate discussions in the same project can reuse the same Claude/Codex provider sessions.

## Start a discussion

1. Call `ask_peer` once for one concrete topic.
2. Structure `message` with: goal, verified evidence, constraints, exact question, and acceptance criteria.
3. Keep the returned `discussionId`. Never create another discussion merely because dispatch is queued.
4. Set `maxTurns` only when the default 12 successful Provider responses is unsuitable.
5. Keep the default `sessionPolicy=auto` for continuity. Use `sessionPolicy=reuse` when continuity is required, and `sessionPolicy=fresh` only when the user explicitly requests an isolated provider context.
6. A fresh discussion ID does not imply a fresh provider session; check `collaborationSessionId` in the result when session continuity matters.

## Continue and wait

- When dispatch is `QUEUED` or `RUNNING`, call `wait_discussion` with the current `discussionId` and last message ID.
- Reuse that `discussionId` with `reply_peer`. Continue only for new evidence, a concrete objection, or an unresolved decision.
- Do not restate prior messages or ask the same question again.
- The peer must not call AgentBridge recursively. Treat peer output as advice and independently verify material claims.

## Finish safely

- On `FAILED`, `TIMEOUT`, or `PEER_BUSY`, inspect `lastError` before calling `retry_discussion` on the same discussion.
- On `NEEDS_USER_DECISION`, present the exact unresolved choice to the user; do not bypass a turn limit or ambiguous Provider result.
- When both sides accept one exact canonical conclusion, call `close_discussion` with that conclusion unchanged.
- Call `cancel_discussion` when the user withdraws the request or continuing could duplicate an ambiguous Provider action.

Session safety:

- Provider sessions are reused only within the same project and only when AgentBridge owns a live, non-superseded session.
- If a provider session disappears or changes backend, AgentBridge records the old session as unavailable and creates a replacement; do not treat a provider session ID as proof of identity outside AgentBridge.
- `agentbridge verify --live` reports real-provider checks as `NOT_TESTED` unless an authenticated E2E harness performs them; never infer live connectivity from local MCP initialization alone.

Read [references/discussion-protocol.md](references/discussion-protocol.md) when status handling or prompt structure needs more detail.
