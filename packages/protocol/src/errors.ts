export type ProviderErrorCode =
  | 'UNAVAILABLE'
  | 'BUSY'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'SESSION_LOST'
  | 'CANCELLED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'FAILED';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly backend?: string;

  constructor(code: ProviderErrorCode, message: string, options: { retryable?: boolean; ambiguous?: boolean; backend?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? (code !== 'AUTH' && code !== 'RATE_LIMIT' && code !== 'CANCELLED');
    this.ambiguous = options.ambiguous ?? false;
    this.backend = options.backend;
  }
}

export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionBusyError';
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  if (value instanceof ProviderError) return true;
  // Keep classification working when an error crosses a package or worker
  // boundary and is backed by a second copy of this module.
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown; ambiguous?: unknown };
  return candidate.name === 'ProviderError'
    && typeof candidate.code === 'string'
    && typeof candidate.ambiguous === 'boolean';
}
