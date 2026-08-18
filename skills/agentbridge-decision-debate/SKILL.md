---
name: agentbridge-decision-debate
description: Use only when the user explicitly asks Claude Code and Codex for a deep AgentBridge debate about an important technical decision.
---

# AgentBridge decision debate

Call `ask_peer` once with `mode=deep-discussion`. State the decision, viable options, important constraints, and desired outcome. Let both Agents challenge and revise their positions freely until they agree or isolate a decision that only the user can make. Return the conclusion, decisive reasons, and unresolved tradeoffs without imposing a separate phase or output template.
