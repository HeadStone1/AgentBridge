---
name: agentbridge-peer-review
description: Obtain a bounded, independent Claude Code–Codex review through AgentBridge. Use for code review, security or design audit, regression risk, test-gap analysis, release-readiness checks, or a focused second opinion where evidence-backed findings matter more than extended debate.
---

# AgentBridge peer review

Use `ask_peer` with `mode=review` and `sessionPolicy=fresh` so the second opinion is independent of an existing project provider session. Keep the default three successful provider responses unless the reviewed scope clearly requires a different safety ceiling.

## Prepare the review

1. Inspect the relevant diff, files, tests, logs, or report first.
2. Send the exact scope, intended behavior, verified evidence, exclusions, and review question.
3. Ask for findings ordered by severity, each with location or observable evidence, impact, and a concrete remediation or test.

## Evaluate the response

- Reproduce or inspect each material claim before presenting it as confirmed.
- Reply only to supply missing evidence, challenge a questionable finding, or validate a proposed fix.
- Distinguish confirmed findings, plausible risks, and non-issues.
- Do not invent findings to fill a quota; a clean review is valid.

## Close

Close on `READY_TO_CLOSE` after findings have dispositions. Surface `NEEDS_USER_DECISION` with the exact risk choice. Cancel or retry according to the core `$agentbridge-collaboration` state rules.

Read [references/review-protocol.md](references/review-protocol.md) for the request and finding formats.
