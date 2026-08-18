import type { DiscussionStatus } from './index.js';

const validTransitions: Record<DiscussionStatus, DiscussionStatus[]> = {
  CREATED: ['DISCUSSING', 'CANCELLED', 'NEEDS_USER_DECISION'],
  DISCUSSING: ['CONFIRMING', 'AGREED', 'FAILED', 'CANCELLED', 'PEER_BUSY', 'TIMEOUT', 'NEEDS_USER_DECISION'],
  CONFIRMING: ['DISCUSSING', 'AGREED', 'FAILED', 'CANCELLED', 'PEER_BUSY', 'TIMEOUT', 'NEEDS_USER_DECISION'],
  // Local MVP discussions may end after both agents agree without entering an
  // implementation workflow. Full implementations can still continue through
  // IMPLEMENTING/REVIEWING.
  AGREED: ['IMPLEMENTING', 'DISCUSSING', 'COMPLETED', 'CANCELLED'],
  IMPLEMENTING: ['REVIEWING', 'FAILED', 'CANCELLED'],
  REVIEWING: ['COMPLETED', 'IMPLEMENTING', 'DISCUSSING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['CREATED', 'CANCELLED'],
  CANCELLED: [],
  PEER_BUSY: ['DISCUSSING', 'CANCELLED', 'TIMEOUT', 'NEEDS_USER_DECISION'],
  TIMEOUT: ['DISCUSSING', 'CANCELLED', 'NEEDS_USER_DECISION'],
  NEEDS_USER_DECISION: ['DISCUSSING', 'CANCELLED'],
};

export function canTransition(
  from: DiscussionStatus,
  to: DiscussionStatus,
): boolean {
  return validTransitions[from]?.includes(to) ?? false;
}

export function getNextStatus(
  current: DiscussionStatus,
  event: 'peer_responded' | 'user_approved' | 'user_rejected' | 'timeout' | 'peer_busy' | 'cancel',
): DiscussionStatus {
  switch (event) {
    case 'peer_responded':
      return 'DISCUSSING';
    case 'user_approved':
      if (current === 'AGREED') return 'IMPLEMENTING';
      if (current === 'REVIEWING') return 'COMPLETED';
      return current;
    case 'user_rejected':
      return 'CANCELLED';
    case 'timeout':
      return 'TIMEOUT';
    case 'peer_busy':
      return 'PEER_BUSY';
    case 'cancel':
      return 'CANCELLED';
    default:
      return current;
  }
}

export function isTerminal(status: DiscussionStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

export function isPaused(status: DiscussionStatus): boolean {
  return status === 'FAILED' || status === 'TIMEOUT' || status === 'PEER_BUSY' || status === 'NEEDS_USER_DECISION';
}

export function canRetry(status: DiscussionStatus): boolean {
  return status === 'FAILED' || status === 'PEER_BUSY' || status === 'TIMEOUT' || status === 'NEEDS_USER_DECISION';
}

export function isError(status: DiscussionStatus): boolean {
  return status === 'FAILED' || status === 'PEER_BUSY' || status === 'TIMEOUT' || status === 'NEEDS_USER_DECISION';
}
