# Peer review protocol

## Request

```text
Review target: <diff, files, release, report, or behavior>
Intended behavior: <what must remain true>
Evidence inspected: <paths, tests, logs, versions>
Focus: <correctness, security, compatibility, robustness, maintainability>
Out of scope: <explicit exclusions>
Acceptance: <what makes the review complete>
```

## Finding

```text
Severity: critical | high | medium | low
Location or evidence: <precise source>
Observed behavior: <fact>
Impact: <why it matters>
Remediation/test: <smallest reliable action>
Confidence: high | medium | low
```

Reject a finding when its premise cannot be reproduced, its location is wrong, or the claimed impact does not follow. Record why it was rejected.
