import { randomUUID } from 'node:crypto';

export function createLiveVerificationToken(
  provider: 'CODEX' | 'CLAUDE',
  nonce = randomUUID(),
): string {
  const normalizedNonce = nonce.replace(/[^a-zA-Z0-9]/g, '');
  if (!normalizedNonce) throw new Error('Live verification nonce must contain at least one alphanumeric character');
  return `LIVE_${provider}_OK_${normalizedNonce}`;
}

export function matchesLiveVerificationToken(content: string, expectedToken: string): boolean {
  return content.trim() === expectedToken;
}
