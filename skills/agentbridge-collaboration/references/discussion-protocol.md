# Discussion protocol

## Request template

```text
Goal: <one outcome>
Evidence: <files, lines, tests, logs, or observed behavior>
Constraints: <scope, safety, compatibility, and prohibited actions>
Question: <one decision or review request>
Acceptance: <conditions for a satisfactory answer>
```

Separate confirmed facts, inferences, and open questions. Never claim evidence that was not inspected.

## Depth contract

| Mode | Default ceiling | Required behavior | Close when |
| --- | ---: | --- | --- |
| `review` | 3 | Single-turn independent review; rank concrete findings by severity and cite observable evidence. | The peer response is available for the caller to assess. |
| `discussion` | 12 | Service automatically alternates both providers until a candidate is accepted or an unresolved disagreement is surfaced. | Both providers accept one exact canonical conclusion hash, or the discussion pauses for user decision. |
| `deep-discussion` | 20 | Service automatically alternates both providers through challenge, evidence, rebuttal, revision, verification, and convergence without a minimum response floor. | Both providers accept one exact canonical conclusion hash, or the discussion pauses for user decision. |

Every peer response must end with exactly one signal:

- `[AGENTBRIDGE_SIGNAL: CONTINUE]` only when new evidence or a material objection remains.
- `[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]` when a canonical conclusion is supportable.
- `[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]` when progress requires a product, risk, permission, or preference choice.

Before continuing, check whether the response adds evidence, changes a position, resolves a decision, or introduces a material objection. Otherwise converge rather than spend the response ceiling.

## State handling

| State | Action |
| --- | --- |
| `QUEUED`, `RUNNING` | Wait with `wait_discussion`; for automatic modes continue while `nextAction=WAIT`; never call `ask_peer` again. |
| `COMPLETED` dispatch | Verify the response, reply with substantive new content, or close. |
| `FAILED` | Read `lastError`; retry only when retryable and not ambiguous. |
| `PEER_BUSY`, `TIMEOUT` | Retry the same discussion after addressing the cause. |
| `NEEDS_USER_DECISION` | Ask the user to resolve the stated choice, `stopReason`, or ambiguity. |
| `COMPLETED`, `CANCELLED` discussion | Stop sending messages. |

`maxTurns` counts substantive successful provider responses; protocol-only agreement confirmations do not consume it. A wait timeout ends only the MCP long poll and does not change discussion status.

Automatic discussion requires both provider connectors. If either connector is missing, `ask_peer` returns `UNAVAILABLE` instead of creating a single-turn fallback. When a conclusion is rejected, the confirmation response may set `resolution` to `continue` or `user_decision`; the latter persists the disagreement and pauses the discussion.

## Session safety

- Reuse provider sessions only within the same project when AgentBridge owns a live, non-superseded session.
- Treat a replaced provider session as unavailable; do not use its ID as identity proof outside AgentBridge.
- Treat `agentbridge verify --live` as `NOT_TESTED` unless an authenticated end-to-end harness performed the provider request.
