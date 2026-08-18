import { describe, expect, it } from 'vitest';
import {
  buildDiscussionPrompt,
  buildAutomaticTurnPrompt,
  defaultMaxTurnsForMode,
  discussionPhase,
  isAutomaticDiscussionMode,
  parseDiscussionSignal,
  parseStructuredTurn,
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
    expect(prompt).toContain('response limit is a ceiling');
    expect(prompt).toContain('<current-request>\nCompare migration A and B.\n</current-request>');
    expect(prompt).toContain('action PROPOSE_CLOSE or REQUEST_USER');
    expect(prompt).not.toContain('AGENTBRIDGE_SIGNAL');
    expect(prompt).not.toContain('peer-temperature-hint');
  });

  it('uses only a compact state line after the first provider turn', () => {
    const prompt = buildDiscussionPrompt({
      mode: 'discussion',
      completedResponses: 4,
      maxTurns: 12,
      prompt: 'Answer the latest objection.',
      includeContract: false,
    });
    expect(prompt).toContain('[agentbridge discussion; synthesis; 4/12]');
    expect(prompt).not.toContain('<agentbridge-discussion-contract>');
  });

  it('accepts only one exact final contract signal', () => {
    expect(parseDiscussionSignal('analysis\n[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE]')).toBe('READY_TO_CLOSE');
    expect(parseDiscussionSignal('[AGENTBRIDGE_SIGNAL: CONTINUE]\n[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION]'))
      .toBeNull();
    expect(parseDiscussionSignal('[AGENTBRIDGE_SIGNAL: CONTINUE]\ntrailing text')).toBeNull();
    expect(parseDiscussionSignal('READY_TO_CLOSE')).toBeNull();
  });

  it('accepts an optional final structured control event while preserving natural reply text', () => {
    const content = [
      'The migration can close if the index build is monitored.',
      '```json',
      '{"agentbridge":{"action":"PROPOSE_CLOSE","summary":"Use the online migration"}}',
      '```',
    ].join('\n');
    expect(parseStructuredTurn(content)).toMatchObject({
      action: 'PROPOSE_CLOSE',
      summary: 'Use the online migration',
    });
    expect(parseDiscussionSignal(content)).toBe('READY_TO_CLOSE');
  });

  it('delays the blackboard until two responses and then injects a bounded snapshot', () => {
    const params: Parameters<typeof buildAutomaticTurnPrompt>[0] = {
      mode: 'discussion',
      completedResponses: 1,
      maxTurns: 12,
      originalRequest: 'Choose a migration.',
      latestMessage: 'Prefer online migration.',
      latestSender: 'claude',
      blackboard: {
        version: 2,
        entries: [{
          kind: 'criterion',
          text: 'Avoid downtime.',
          sourceMessageId: 'msg_source',
          agent: 'claude',
          timestamp: '2026-08-17T00:00:00.000Z',
          versionAdded: 2,
        }],
      },
    };
    const earlyPrompt = buildAutomaticTurnPrompt(params);
    expect(earlyPrompt).not.toContain('<shared-blackboard>');

    const prompt = buildAutomaticTurnPrompt({ ...params, completedResponses: 2 });
    expect(prompt).toContain('<shared-blackboard>');
    expect(prompt).toContain('msg_source');
    expect(prompt).toContain('memory aid, not ground truth');
    expect(prompt.length).toBeLessThan(3_000);
  });

  it('does not repeat the original goal after a provider has joined the discussion', () => {
    const prompt = buildAutomaticTurnPrompt({
      mode: 'discussion',
      completedResponses: 3,
      maxTurns: 12,
      originalRequest: 'Choose a migration.',
      latestMessage: 'The online path avoids downtime.',
      latestSender: 'codex',
      includeContract: false,
      includeOriginalRequest: false,
    });
    expect(prompt).not.toContain('Choose a migration.');
    expect(prompt).toContain('The online path avoids downtime.');
    expect(prompt).not.toContain('<agentbridge-discussion-contract>');
  });
});
