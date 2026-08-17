# AgentBridge Security Baseline

## Scope

AgentBridge treats provider output as untrusted input. Provider messages must not
grant shell, filesystem, credential, or project access by themselves.

## Required invariants

- A discussion has exactly two registered agents and a project path.
- Only those agents may write messages or accept a decision.
- Both agents must accept the same decision hash before completion.
- Provider credentials stay on the local machine and are never persisted in the
  discussion database.
- Messages and conclusions have bounded sizes; discussions have bounded turns.
- Audit events are append-only through the application API for the lifetime of a retained discussion; explicit retention cleanup may delete old discussions and their audit history.

## Before release

- Implement and test SessionLease for provider-native sessions.
- Add authentication and authorization around any network-facing Hub.
- Add prompt-injection and secret-redaction tests.
- Run the security and E2E suites against real Claude/Codex connectors before declaring a provider-certified release; automated fixture tests alone are not that certification.
