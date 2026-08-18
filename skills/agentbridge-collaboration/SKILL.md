---
name: agentbridge-collaboration
description: Use AgentBridge MCP when the user asks Claude Code and Codex to consult, discuss, review, or reach a joint conclusion.
---

# AgentBridge collaboration

Use AgentBridge as a direct communication channel between Claude Code and Codex.

## Start

- Call `ask_peer` once with the user's goal and the active project path.
- Use `review` for one independent response, `discussion` for an automatic exchange, and `deep-discussion` only when the user asks for a deeper debate.
- Keep the returned `discussionId`; do not create a duplicate discussion for the same topic.

## Let the conversation finish

- `discussion` and `deep-discussion` normally run the complete alternating conversation before `ask_peer` returns.
- Read the returned status, conclusion, and transcript. Do not stop at an intermediate message.
- Use `wait_discussion` only if the call explicitly returns `nextAction=WAIT`, which means background dispatch was enabled.
- Use `reply_peer` only when the service requests a user decision or the user supplies material new information.

## Return the result

Present the useful conclusion and any unresolved disagreement to the user. The service handles turn-taking and agreement signals; do not manually reproduce its protocol or require a special request template.
