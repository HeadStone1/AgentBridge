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
| `review` | 3 | Inspect independently; rank concrete findings by severity; cite observable evidence. | Findings are resolved, accepted, or none remain. |
| `discussion` | 12 | State a position, test substantive objections, revise from evidence, synthesize tradeoffs. | Acceptance criteria hold and no material objection remains. |
| `deep-discussion` | 20 | Progress through challenge, evidence, rebuttal, revision, verification, and convergence. | Strongest counterargument and alternatives have been tested. |

Every peer response must end with exactly one signal:

- `[AGENTBRIDGE_SIGNAL: CONTINUE]` only when new evidence or a material objection remains.
- `[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]` when a canonical conclusion is supportable.
- `[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]` when progress requires a product, risk, permission, or preference choice.

Before continuing, check whether the response adds evidence, changes a position, resolves a decision, or introduces a material objection. Otherwise converge rather than spend the response ceiling.

## State handling

| State | Action |
| --- | --- |
| `QUEUED`, `RUNNING` | Wait with `wait_discussion`; never call `ask_peer` again. |
| `COMPLETED` dispatch | Verify the response, reply with substantive new content, or close. |
| `FAILED` | Read `lastError`; retry only when retryable and not ambiguous. |
| `PEER_BUSY`, `TIMEOUT` | Retry the same discussion after addressing the cause. |
| `NEEDS_USER_DECISION` | Ask the user to resolve the stated choice, `stopReason`, or ambiguity. |
| `COMPLETED`, `CANCELLED` discussion | Stop sending messages. |

`maxTurns` counts successful provider responses. A wait timeout ends only the MCP long poll and does not change discussion status.

## Session safety

- Reuse provider sessions only within the same project when AgentBridge owns a live, non-superseded session.
- Treat a replaced provider session as unavailable; do not use its ID as identity proof outside AgentBridge.
- Treat `agentbridge verify --live` as `NOT_TESTED` unless an authenticated end-to-end harness performed the provider request.
