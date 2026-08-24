import { describe, expect, it } from 'vitest';
import { HeadlessPeerPolicy } from '../../packages/connectors/src/policy';

describe('HEADLESS_PEER policy', () => {
  const projectPath = 'G:/agentbridge-project';
  const policy = new HeadlessPeerPolicy(projectPath);

  it('allows normal project-scoped test and build approvals', () => {
    expect(policy.decide({
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test', cwd: projectPath },
    })).toBe('ALLOW');
    expect(policy.decide({
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm run build', cwd: projectPath },
    })).toBe('ALLOW');
  });

  it('denies destructive or out-of-project approvals', () => {
    expect(policy.decide({
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git reset --hard', cwd: projectPath },
    })).toBe('DENY');
    expect(policy.decide({
      method: 'item/fileChange/requestApproval',
      params: { path: `${projectPath}/src/index.ts` },
    })).toBe('NEEDS_USER_DECISION');
    expect(policy.decide({
      method: 'item/fileChange/requestApproval',
      params: { path: 'G:/other-project/secret.txt' },
    })).toBe('DENY');
  });

  it('does not turn unknown invisible prompts into an implicit allow', () => {
    expect(policy.decide({
      method: 'item/unknown/requestApproval',
      params: { cwd: projectPath },
    })).toBe('NEEDS_USER_DECISION');
  });
});
