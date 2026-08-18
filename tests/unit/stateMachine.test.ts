import { describe, it, expect } from 'vitest';
import { canRetry, canTransition, getNextStatus, isError, isPaused, isTerminal } from '../../packages/protocol/src/stateMachine';
import type { DiscussionStatus } from '../../packages/protocol/src/index';

describe('State Machine', () => {
  describe('canTransition', () => {
    it('CREATED -> DISCUSSING is valid', () => {
      expect(canTransition('CREATED', 'DISCUSSING')).toBe(true);
    });

    it('DISCUSSING -> AGREED is valid', () => {
      expect(canTransition('DISCUSSING', 'AGREED')).toBe(true);
    });

    it('uses CONFIRMING only for the candidate conclusion handshake', () => {
      expect(canTransition('DISCUSSING', 'CONFIRMING')).toBe(true);
      expect(canTransition('CONFIRMING', 'DISCUSSING')).toBe(true);
      expect(canTransition('CONFIRMING', 'AGREED')).toBe(true);
    });

    it('DISCUSSING -> COMPLETED is invalid', () => {
      expect(canTransition('DISCUSSING', 'COMPLETED')).toBe(false);
    });

    it('COMPLETED -> any is invalid (terminal)', () => {
      expect(canTransition('COMPLETED', 'DISCUSSING')).toBe(false);
      expect(canTransition('COMPLETED', 'FAILED')).toBe(false);
    });

    it('DISCUSSING -> TIMEOUT is valid', () => {
      expect(canTransition('DISCUSSING', 'TIMEOUT')).toBe(true);
    });

    it('DISCUSSING -> PEER_BUSY is valid', () => {
      expect(canTransition('DISCUSSING', 'PEER_BUSY')).toBe(true);
    });
  });

  describe('getNextStatus', () => {
    it('peer_responded -> DISCUSSING', () => {
      expect(getNextStatus('CREATED', 'peer_responded')).toBe('DISCUSSING');
    });

    it('user_approved on AGREED -> IMPLEMENTING', () => {
      expect(getNextStatus('AGREED', 'user_approved')).toBe('IMPLEMENTING');
    });

    it('user_approved cannot skip straight from DISCUSSING to COMPLETED', () => {
      expect(getNextStatus('DISCUSSING', 'user_approved')).toBe('DISCUSSING');
    });

    it('user_rejected -> CANCELLED', () => {
      expect(getNextStatus('DISCUSSING', 'user_rejected')).toBe('CANCELLED');
    });

    it('timeout -> TIMEOUT', () => {
      expect(getNextStatus('DISCUSSING', 'timeout')).toBe('TIMEOUT');
    });
  });

  describe('isTerminal', () => {
    it('only COMPLETED/CANCELLED are terminal', () => {
      expect(isTerminal('COMPLETED')).toBe(true);
      expect(isTerminal('FAILED')).toBe(false);
      expect(isTerminal('CANCELLED')).toBe(true);
    });

    it('DISCUSSING/AGREED are not terminal', () => {
      expect(isTerminal('DISCUSSING')).toBe(false);
      expect(isTerminal('AGREED')).toBe(false);
    });
  });

  describe('isError', () => {
    it('FAILED/PEER_BUSY/TIMEOUT are error states', () => {
      expect(isError('FAILED')).toBe(true);
      expect(isError('PEER_BUSY')).toBe(true);
      expect(isError('TIMEOUT')).toBe(true);
    });

    it('DISCUSSING/AGREED are not error states', () => {
      expect(isError('DISCUSSING')).toBe(false);
      expect(isError('AGREED')).toBe(false);
    });
  });

  describe('paused/retry states', () => {
    it('requires the retry API for paused states', () => {
      expect(isPaused('TIMEOUT')).toBe(true);
      expect(isPaused('PEER_BUSY')).toBe(true);
      expect(isPaused('FAILED')).toBe(true);
      expect(canRetry('TIMEOUT')).toBe(true);
      expect(canRetry('CANCELLED')).toBe(false);
      expect(canTransition('CANCELLED', 'CREATED')).toBe(false);
    });
  });
});
