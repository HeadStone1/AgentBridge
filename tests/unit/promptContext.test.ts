import { describe, expect, it } from 'vitest';
import type { Message } from '../../packages/protocol/src/index';
import { buildPeerPrompt } from '../../packages/connectors/src/prompt';

describe('bounded peer context', () => {
  it('keeps the initial proposal and newest messages within a character budget', () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(index, `message-${index}-${'x'.repeat(180)}`));
    const prompt = buildPeerPrompt('current request', messages, 1_200);

    expect(prompt).toContain('message-0-');
    expect(prompt).toContain('message-19-');
    expect(prompt).toContain('Earlier messages were omitted');
    expect(prompt.length).toBeLessThan(1_600);
    expect(prompt.match(/message-10-/)).toBeNull();
  });

  it('does not duplicate the current request when no historical messages exist', () => {
    expect(buildPeerPrompt('current request', [])).toBe('current request');
  });
});

function message(index: number, content: string): Message {
  return {
    id: `msg_${index}`,
    discussionId: 'dsc_prompt',
    sender: index % 2 === 0 ? 'claude' : 'codex',
    receiver: index % 2 === 0 ? 'codex' : 'claude',
    role: index === 0 ? 'proposal' : 'response',
    content,
    createdAt: new Date(index).toISOString(),
    parentMessageId: null,
    correlationId: `cor_${index}`,
  };
}
