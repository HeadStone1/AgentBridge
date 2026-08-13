import {
  DEFAULT_DISCUSSION_MODE,
  DEFAULT_MAX_TURNS_BY_MODE,
  DISCUSSION_MODES,
  type DiscussionMode,
  type DiscussionSignal,
} from '@agentbridge/protocol';

const DEEP_PHASES = ['challenge', 'evidence', 'rebuttal', 'revision', 'verification', 'convergence'] as const;

export function assertDiscussionMode(value: unknown): asserts value is DiscussionMode {
  if (!DISCUSSION_MODES.includes(value as DiscussionMode)) {
    throw new Error(`mode must be one of: ${DISCUSSION_MODES.join(', ')}`);
  }
}

export function resolveDiscussionMode(value: unknown): DiscussionMode {
  const mode = value ?? DEFAULT_DISCUSSION_MODE;
  assertDiscussionMode(mode);
  return mode;
}

export function defaultMaxTurnsForMode(mode: DiscussionMode): number {
  return DEFAULT_MAX_TURNS_BY_MODE[mode];
}

export function discussionPhase(mode: DiscussionMode, completedResponses: number): string {
  if (mode === 'review') return 'independent-review';
  if (mode === 'discussion') {
    if (completedResponses === 0) return 'position';
    if (completedResponses === 1) return 'challenge';
    return 'synthesis';
  }
  return DEEP_PHASES[Math.min(Math.max(completedResponses, 0), DEEP_PHASES.length - 1)];
}

export function buildDiscussionPrompt(params: {
  mode: DiscussionMode;
  completedResponses: number;
  maxTurns: number;
  prompt: string;
}): string {
  const phase = discussionPhase(params.mode, params.completedResponses);
  const modeRules = params.mode === 'review'
    ? [
        'Review independently. Prioritize concrete defects, regressions, missing tests, and operational risks by severity.',
        'Tie every finding to observable evidence. If no actionable finding remains, say so directly.',
      ]
    : params.mode === 'deep-discussion'
      ? [
          `Work the current phase (${phase}) before attempting consensus. State the strongest counterargument, supporting evidence, uncertainty, and any revised position.`,
          'Do not accept a conclusion until material objections and alternatives have been tested.',
        ]
      : [
          'Advance the decision with evidence, a substantive objection, or a concrete synthesis; do not restate prior messages.',
          'Surface unresolved tradeoffs and revise your position when the evidence warrants it.',
        ];

  return [
    '<agentbridge-discussion-contract>',
    `mode: ${params.mode}`,
    `phase: ${phase}`,
    `successful-provider-responses: ${params.completedResponses}/${params.maxTurns}`,
    'The response limit is a safety ceiling, not a target. Converge early when acceptance criteria are met.',
    ...modeRules,
    'End with exactly one signal line:',
    '[AGENTBRIDGE_SIGNAL: CONTINUE] when new evidence or a material objection remains;',
    '[AGENTBRIDGE_SIGNAL: READY_TO_CLOSE] when a canonical conclusion is supportable;',
    '[AGENTBRIDGE_SIGNAL: NEEDS_USER_DECISION] when the blocker is a product, risk, permission, or preference choice.',
    '</agentbridge-discussion-contract>',
    '',
    '<current-request>',
    params.prompt,
    '</current-request>',
  ].join('\n');
}

export function parseDiscussionSignal(content: string): DiscussionSignal | null {
  const matches = [...content.matchAll(/\[AGENTBRIDGE_SIGNAL:\s*(CONTINUE|READY_TO_CLOSE|NEEDS_USER_DECISION)\]/g)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!content.trimEnd().endsWith(match[0])) return null;
  return match[1] as DiscussionSignal;
}
