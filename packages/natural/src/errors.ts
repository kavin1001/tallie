export type NaturalErrorReason =
  | 'configuration'
  | 'invalid_input'
  | 'transport'
  | 'timeout'
  | 'http'
  | 'invalid_response'
  | 'binding_mismatch';

/** Unknown means a mutation may have succeeded. Never replace its operation/key. */
export type NaturalOutcome = 'not_submitted' | 'rejected' | 'unknown';

/** Intentionally excludes upstream bodies, key bytes, URLs, PII, and error causes. */
export class NaturalProviderError extends Error {
  constructor(
    public readonly reason: NaturalErrorReason,
    public readonly outcome: NaturalOutcome,
    public readonly status: number | null = null,
  ) {
    super(`Natural sandbox ${reason.replaceAll('_', ' ')}.`);
    this.name = 'NaturalProviderError';
  }
}
