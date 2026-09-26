import { DomainError } from './errors';

/** Matches the positive range of PostgreSQL bigint, our persistence type. */
export const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
export const CURRENCY = 'USD' as const;

export function assertMinorUnits(amount: bigint, allowZero = true): void {
  if (typeof amount !== 'bigint' || amount < 0n || (!allowZero && amount === 0n)) {
    throw new DomainError(
      'INVALID_AMOUNT',
      allowZero
        ? 'Amount must be a nonnegative integer number of cents.'
        : 'Amount must be a positive integer number of cents.',
    );
  }
  if (amount > MAX_MINOR_UNITS) {
    throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds the supported storage range.');
  }
}

/** Parses a human-entered dollar decimal without ever using floating point. */
export function parseUsd(input: string): bigint {
  if (typeof input !== 'string' || input.length > 24) {
    throw new DomainError(
      'INVALID_AMOUNT',
      'Enter a dollar amount with at most two decimal places.',
    );
  }
  const value = input.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new DomainError(
      'INVALID_AMOUNT',
      'Enter a dollar amount with at most two decimal places.',
    );
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  assertMinorUnits(cents);
  return cents;
}

/** Strict transport format: canonical unsigned integer cents, never a JSON number. */
export function parseMinorUnits(input: string): bigint {
  if (typeof input !== 'string' || input !== input.trim() || !/^(?:0|[1-9]\d{0,18})$/.test(input)) {
    throw new DomainError('INVALID_AMOUNT', 'Amount must be a canonical integer-cent string.');
  }
  const cents = BigInt(input);
  assertMinorUnits(cents);
  return cents;
}

export function formatDecimalUsd(amount: bigint): string {
  assertMinorUnits(amount);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

/** Full-precision display formatting, including values beyond Number.MAX_SAFE_INTEGER. */
export function formatUsd(amount: bigint): string {
  const [whole = '0', fraction = '00'] = formatDecimalUsd(amount).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
