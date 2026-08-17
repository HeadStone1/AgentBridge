---
name: agentbridge-collaboration
description: Route and manage bounded Claude Code–Codex collaboration through AgentBridge MCP. Use for general peer consultation, continuing or recovering an AgentBridge discussion, choosing review versus discussion depth, waiting on provider work, or reaching a canonical conclusion. Prefer the focused agentbridge-peer-review skill for defect reviews and agentbridge-decision-debate for high-impact tradeoff decisions.
---

# AgentBridge collaboration

Treat AgentBridge as a bounded, evidence-driven collaboration channel. Reuse one discussion for one topic and independently verify material peer claims.

## Choose depth

- Use `mode=review` for a scoped audit, second opinion, regression check, or defect hunt. Prefer `$agentbridge-peer-review` when available.
- Use `mode=discussion` for ordinary design questions and implementation tradeoffs.
- Use `mode=deep-discussion` for architecture, security boundaries, irreversible changes, or unresolved substantive disagreement. Prefer `$agentbridge-decision-debate` when available.

Keep each mode's default response ceiling unless risk or scope justifies an explicit `maxTurns`. Treat the ceiling as a safety limit, never a target.

`review` is a single-turn independent review. `discussion` and `deep-discussion` are automatic alternating runs when both providers are available; they stop as soon as the providers agree or an irreconcilable decision is surfaced. The service performs the follow-up provider calls, so the initiating Agent must not summarize an intermediate result as final. Missing connectors are reported as `UNAVAILABLE` and never downgraded to a single-turn result.

## Start

1. Call `ask_peer` once with one concrete topic, the selected `mode`, and the project path.
2. Structure `message` with goal, verified evidence, constraints, exact question, and acceptance criteria.
3. Keep the returned `discussionId`. Do not start a replacement because dispatch is queued.
4. Keep `sessionPolicy=auto` normally. Use `reuse` when continuity is required and `fresh` only for explicitly isolated provider context.

## Continue

- For `QUEUED` or `RUNNING`, call `wait_discussion` with the same discussion ID and latest message ID.
- For automatic `discussion` or `deep-discussion`, keep waiting while `nextAction=WAIT`, even if an intermediate message is returned. Inspect the full transcript after completion.
- Call `reply_peer` only with new evidence, a concrete objection, a revised position, or an unresolved decision.
- Honor the peer's final `AGENTBRIDGE_SIGNAL`: verify `READY_TO_CLOSE`; continue only when `CONTINUE` is backed by substance; surface the exact choice on `NEEDS_USER_DECISION`.
- Do not repeat prior content or allow recursive AgentBridge calls from the peer.

## Finish

- Inspect `lastError` before retrying `FAILED`, `TIMEOUT`, or `PEER_BUSY` on the same discussion.
- Ask the user to resolve product, permission, risk, or preference choices in `NEEDS_USER_DECISION`.
- Call `close_discussion` only when both sides can accept one exact canonical conclusion.
- Call `cancel_discussion` when the user withdraws the request or continuing risks duplicating an ambiguous provider action.

Read [references/discussion-protocol.md](references/discussion-protocol.md) for the mode contract, convergence checks, state handling, and request template.
