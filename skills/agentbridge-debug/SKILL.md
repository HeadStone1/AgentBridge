---
name: agentbridge-debug
description: Use only when the user explicitly asks Claude Code and Codex to diagnose a reproducible bug together through AgentBridge.
---

# AgentBridge debug

Call `ask_peer` once with `mode=discussion`. Include the observed failure, expected behavior, reproduction, and the most relevant code or logs that are already available. Let the two Agents exchange hypotheses and tests automatically, then return the agreed cause, fix, and remaining uncertainty. Reuse the same `discussionId` if the user later supplies new evidence.
