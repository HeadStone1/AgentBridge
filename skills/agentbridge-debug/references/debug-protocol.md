# Debug protocol

## Request

```text
Failure: <smallest reproducible symptom>
Expected: <observable behavior>
Observed: <observable behavior and exact error>
Environment: <versions, platform, configuration>
Reproduction: <ordered minimal steps>
Evidence: <paths, logs, traces, tests, recent changes>
Known facts: <confirmed observations>
Hypotheses: <ranked candidates, if any>
Constraints: <safety, compatibility, time, unavailable systems>
```

## Experiment

```text
Hypothesis: <single causal claim>
Prediction: <result expected if true>
Action: <one controlled check or change>
Observed result: <fact>
Disposition: supported | weakened | falsified
Next discriminating check: <smallest useful follow-up>
```

## Final diagnosis

```text
Root cause: <causal chain, not symptom restatement>
Confidence: high | medium | low
Fix: <smallest safe change>
Original reproduction: pass | fail
Focused regression: <test and result>
Broader verification: <checks and result>
Residual risks: <what remains unverified>
```

Do not claim a root cause from correlation alone. If the evidence supports only mitigation, label it as a workaround and preserve the unresolved hypothesis.
