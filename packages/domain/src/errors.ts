export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'INVALID_PARTICIPANTS'
  | 'INVALID_ITEMS'
  | 'ALLOCATION_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'INVALID_DISCOUNT'
  | 'INVALID_RULE'
  | 'INVALID_TRANSITION';

/** Safe, stable codes for API mapping; messages never include caller-supplied data. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
