import { describe, expect, it } from 'vitest';
import { createLiveVerificationToken, matchesLiveVerificationToken } from '../../packages/cli/src/verify';

describe('live verification result validation', () => {
  it('builds a provider-specific token from a per-run nonce', () => {
    expect(createLiveVerificationToken('CODEX', 'run-123')).toBe('LIVE_CODEX_OK_run123');
    expect(createLiveVerificationToken('CLAUDE', 'run-456')).toBe('LIVE_CLAUDE_OK_run456');
    expect(() => createLiveVerificationToken('CODEX', '---')).toThrow('nonce');
  });

  it('accepts only the exact requested token with surrounding whitespace', () => {
    expect(matchesLiveVerificationToken(' LIVE_CODEX_OK\n', 'LIVE_CODEX_OK')).toBe(true);
    expect(matchesLiveVerificationToken('LIVE_CLAUDE_OK', 'LIVE_CLAUDE_OK')).toBe(true);
  });

  it('rejects non-empty, decorated, or wrong-provider responses', () => {
    for (const response of [
      'looks good',
      'LIVE_CODEX_OK with explanation',
      'prefix LIVE_CODEX_OK',
      'LIVE_CLAUDE_OK',
      '',
    ]) {
      expect(matchesLiveVerificationToken(response, 'LIVE_CODEX_OK')).toBe(false);
    }
  });
});
