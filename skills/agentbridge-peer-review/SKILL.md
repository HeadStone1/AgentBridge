---
name: agentbridge-peer-review
description: Use only when the user explicitly asks for an independent AgentBridge peer review by the other Agent.
---

# AgentBridge peer review

Call `ask_peer` once with `mode=review`. Provide the review target, intended behavior, and relevant evidence already inspected. Return the peer's concrete findings and clearly distinguish confirmed issues from suggestions. Do not require a fixed finding format or start another discussion unless the user asks.
