---
name: agentbridge-decision-debate
description: Run a deep, evidence-driven Claude Code–Codex decision debate through AgentBridge. Use for architecture choices, security boundaries, irreversible migrations, costly tradeoffs, conflicting implementation strategies, or substantive disagreement that needs challenge, rebuttal, revision, and explicit convergence.
---

# AgentBridge decision debate

Use `ask_peer` with `mode=deep-discussion`. Keep the default 20-response safety ceiling; convergence should normally happen earlier.

## Frame the decision

1. State the decision, viable options, verified facts, assumptions, constraints, reversibility, and acceptance criteria.
2. Identify who owns product, permission, budget, and risk choices.
3. Ask the peer to attack the strongest current option, not merely endorse it.

## Enforce depth

- Progress through challenge, evidence, rebuttal, revision, verification, and convergence.
- Demand evidence for disputed factual claims and label inference or uncertainty.
- Compare options against the same criteria, including failure modes and rollback cost.
- Revise the position when counterevidence wins. Do not preserve disagreement for appearance.
- Reply only when adding evidence, answering a material objection, or changing the decision record.

## Converge

- On `READY_TO_CLOSE`, write one canonical conclusion containing the chosen option, decisive evidence, rejected alternatives, residual risks, and verification plan.
- On `NEEDS_USER_DECISION`, stop and present only the unresolved user-owned choice with consequences.
- On repeated `CONTINUE` without new substance, synthesize and close rather than consuming the ceiling.

Read [references/debate-protocol.md](references/debate-protocol.md) for phases and the decision record.
