# Discussion protocol

## Request template

```text
Goal: <one outcome>
Evidence: <files, lines, tests, logs, or observed behavior>
Constraints: <scope, safety, compatibility, and prohibited actions>
Question: <one decision or review request>
Acceptance: <conditions for a satisfactory answer>
```

Do not claim evidence that was not inspected. Separate confirmed facts, inferences, and open questions.

## State handling

| State | Action |
| --- | --- |
| `QUEUED`, `RUNNING` | Wait with `wait_discussion`; do not call `ask_peer` again. |
| `COMPLETED` dispatch | Read the new response and either verify it, reply with new evidence, or close. |
| `FAILED` | Read `lastError`; retry only when retryable and not ambiguous. |
| `PEER_BUSY`, `TIMEOUT` | Retry the same discussion after the cause is addressed. |
| `NEEDS_USER_DECISION` | Ask the user to resolve the stated `stopReason` or ambiguity. |
| `COMPLETED`, `CANCELLED` discussion | Stop sending messages. |

`maxTurns` counts successful Provider responses, not complete back-and-forth rounds. A wait timeout only ends the MCP long poll; it does not change discussion status.
