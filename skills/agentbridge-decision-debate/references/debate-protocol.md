# Decision debate protocol

## Phases

1. **Challenge:** identify the strongest objection, hidden assumption, and failure mode.
2. **Evidence:** supply reproducible facts and separate them from inference.
3. **Rebuttal:** test whether evidence answers the strongest objection.
4. **Revision:** update options, constraints, or position explicitly.
5. **Verification:** check the revised choice against acceptance criteria and rollback needs.
6. **Convergence:** produce one decision or isolate one user-owned blocker.

Do not mechanically repeat phases after the issue is settled. The injected AgentBridge contract reports the current expected phase.

## Canonical decision record

```text
Decision: <chosen option>
Decisive evidence: <verified facts>
Rejected alternatives: <option and reason>
Residual risks: <known uncertainty and mitigation>
Verification: <tests or observations required>
Rollback: <trigger and recovery path>
```

Escalate only choices that require user authority or preference. Technical uncertainty remains the agents' responsibility to investigate within scope.
