---
name: agentbridge-debug
description: Diagnose a reproducible bug with an evidence-driven Claude Code-Codex loop through AgentBridge. Use for runtime failures, flaky tests, regressions, state corruption, integration faults, or root-cause investigations that need competing hypotheses and targeted experiments. Do not use for broad code review, open-ended architecture debate, or implementation with an already-confirmed cause.
---

# AgentBridge debug

Use `ask_peer` with `mode=discussion` for a bounded diagnosis. Escalate the same discussion with `reply_peer(mode=deep-discussion)` only when the fault crosses components, evidence conflicts, or the proposed fix carries substantial migration or security risk.

## Establish the failure

1. Record the smallest reproducible case, expected behavior, observed behavior, environment, and exact error evidence.
2. Separate confirmed facts from hypotheses. Do not ask the peer to guess from a symptom alone.
3. Send relevant source locations, logs, traces, recent changes, and tests while excluding secrets and unrelated output.

## Test hypotheses

- Rank hypotheses by fit with the evidence and cost to falsify.
- Change one variable per experiment and state the predicted observation first.
- Reject explanations contradicted by the result; do not preserve them by adding assumptions.
- Reuse the same `discussionId` so corrections and negative evidence remain in one audit trail.
- Stop repetitive exchanges that add neither a new observation nor a falsifiable prediction.

## Verify the resolution

Require a causal explanation connecting trigger, faulty state transition, and observed symptom. Then verify the smallest safe fix with the original reproduction, a focused regression test, and relevant broader checks. Distinguish a workaround from a root-cause fix.

Close on `READY_TO_CLOSE` only when the cause and verification evidence are both explicit. Surface `NEEDS_USER_DECISION` when the remaining choice is product policy, risk tolerance, or permission rather than diagnosis.

Read [references/debug-protocol.md](references/debug-protocol.md) for the request, experiment, and output contracts. Follow `$agentbridge-collaboration` for waiting, retry, cancellation, and session safety.
