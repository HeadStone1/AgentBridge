import type { DiscussionStatus } from './index.js';

const validTransitions: Record<DiscussionStatus, DiscussionStatus[]> = {
  CREATED: ['DISCUSSING', 'NEEDS_USER_DECISION'],
  DISCUSSING: ['AGREED', 'FAILED', 'CANCELLED', 'PEER_BUSY', 'TIMEOUT', 'NEEDS_USER_DECISION'],
  // Local MVP discussions may end after both agents agree without entering an
  // implementation workflow. Full implementations can still continue through
  // IMPLEMENTING/REVIEWING.
  AGREED: ['IMPLEMENTING', 'DISCUSSING', 'COMPLETED'],
  IMPLEMENTING: ['REVIEWING', 'FAILED'],
  REVIEWING: ['COMPLETED', 'IMPLEMENTING', 'DISCUSSING'],
  COMPLETED: [],
  FAILED: ['CREATED'], // Can retry
  CANCELLED: ['CREATED'], // Can retry
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
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'NEEDS_USER_DECISION';
}

export function isError(status: DiscussionStatus): boolean {
  return status === 'FAILED' || status === 'PEER_BUSY' || status === 'TIMEOUT' || status === 'NEEDS_USER_DECISION';
}
