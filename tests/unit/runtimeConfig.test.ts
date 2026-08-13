import { describe, expect, it } from 'vitest';
import { readOptionalBoundedInteger } from '../../packages/mcp/src/runtimeConfig';

describe('MCP runtime configuration', () => {
  it('does not override mode-specific turn defaults unless the environment is explicit', () => {
    expect(readOptionalBoundedInteger('AGENTBRIDGE_MAX_TURNS', 1, 50, {})).toBeUndefined();
    expect(readOptionalBoundedInteger('AGENTBRIDGE_MAX_TURNS', 1, 50, {
      AGENTBRIDGE_MAX_TURNS: '7',
    })).toBe(7);
  });

  it('rejects malformed or out-of-range explicit overrides', () => {
    for (const value of ['zero', '7x', '7.5', '0', '51']) {
      expect(() => readOptionalBoundedInteger('AGENTBRIDGE_MAX_TURNS', 1, 50, {
        AGENTBRIDGE_MAX_TURNS: value,
      })).toThrow('AGENTBRIDGE_MAX_TURNS must be an integer between 1 and 50');
    }
  });
});
