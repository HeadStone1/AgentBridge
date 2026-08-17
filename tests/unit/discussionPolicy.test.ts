import { describe, expect, it } from 'vitest';
import {
  buildDiscussionPrompt,
  defaultMaxTurnsForMode,
  discussionPhase,
  isAutomaticDiscussionMode,
  parseDiscussionSignal,
  resolveDiscussionMode,
} from '../../packages/collaboration/src/discussionPolicy';

describe('discussion depth policy', () => {
  it('uses stable mode budgets and preserves the legacy default mode', () => {
    expect(resolveDiscussionMode(undefined)).toBe('discussion');
    expect(defaultMaxTurnsForMode('review')).toBe(3);
    expect(defaultMaxTurnsForMode('discussion')).toBe(12);
    expect(defaultMaxTurnsForMode('deep-discussion')).toBe(20);
    expect(isAutomaticDiscussionMode('review')).toBe(false);
    expect(isAutomaticDiscussionMode('discussion')).toBe(true);
    expect(() => resolveDiscussionMode('unbounded')).toThrow('mode must be one of');
  });

  it('advances deep discussion phases and saturates at convergence', () => {
    expect([0, 1, 2, 3, 4, 5, 99].map((round) => discussionPhase('deep-discussion', round)))
      .toEqual(['challenge', 'evidence', 'rebuttal', 'revision', 'verification', 'convergence', 'convergence']);
  });

  it('wraps untrusted requests in an explicit bounded response contract', () => {
    const prompt = buildDiscussionPrompt({
      mode: 'deep-discussion',
      completedResponses: 2,
      maxTurns: 20,
      prompt: 'Compare migration A and B.',
    });
    expect(prompt).toContain('mode: deep-discussion');
    expect(prompt).toContain('phase: rebuttal');
    expect(prompt).toContain('2/20');
    expect(prompt).toContain('safety ceiling, not a target');
    expect(prompt).toContain('<current-request>\nCompare migration A and B.\n</current-request>');
    expect(prompt).toContain('[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]');
  });

  it('accepts only one exact final contract signal', () => {
    expect(parseDiscussionSignal('analysis\n[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]')).toBe('READY_TO_CLOSE');
    expect(parseDiscussionSignal('[AGENTBRIDGE_SIGNAL: CONTINUE]\n[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]'))
      .toBeNull();
    expect(parseDiscussionSignal('[AGENTBRIDGE_SIGNAL: CONTINUE]\ntrailing text')).toBeNull();
    expect(parseDiscussionSignal('READY_TO_CLOSE')).toBeNull();
  });
});
