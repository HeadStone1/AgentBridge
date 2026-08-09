import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectPath } from '@agentbridge/protocol';

describe('project path resolution', () => {
  it('uses explicit, AgentBridge, Claude, then cwd priority', () => {
    const cwd = resolve('cwd-project');
    const env = {
      AGENTBRIDGE_PROJECT_PATH: resolve('agentbridge-project'),
      CLAUDE_PROJECT_DIR: resolve('claude-project'),
    };
    expect(resolveProjectPath(resolve('explicit-project'), env, cwd)).toBe(resolve('explicit-project'));
    expect(resolveProjectPath(undefined, env, cwd)).toBe(env.AGENTBRIDGE_PROJECT_PATH);
    expect(resolveProjectPath(undefined, { CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR }, cwd)).toBe(env.CLAUDE_PROJECT_DIR);
    expect(resolveProjectPath(undefined, {}, cwd)).toBe(cwd);
  });
});
