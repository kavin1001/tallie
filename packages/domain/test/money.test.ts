import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DomainError,
  MAX_MINOR_UNITS,
  formatDecimalUsd,
  formatUsd,
  parseMinorUnits,
  parseUsd,
} from '../src';

describe('exact USD amounts', () => {
  it.each([
    ['0', 0n],
    ['0.01', 1n],
    ['12.3', 1230n],
    [' 117.00 ', 11700n],
    ['90071992547409.93', 9007199254740993n],
    ['92233720368547758.07', MAX_MINOR_UNITS],
  ])('parses %s as exact cents', (input, expected) => {
    expect(parseUsd(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '.50',
    '1.',
    '01.00',
    '-1',
    '+1',
    '1.001',
    '1e2',
    'NaN',
    'Infinity',
    '$1',
    '1,000',
    '1 00',
    '1\n2',
    '１２.３４',
  ])('rejects ambiguous or malformed decimal %j', (input) => {
    expect(() => parseUsd(input)).toThrow(DomainError);
  });

  it('rejects overflow instead of truncating', () => {
    expect(() => parseUsd('92233720368547758.08')).toThrow(
      expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }),
    );
    expect(() => parseMinorUnits('9223372036854775808')).toThrow(DomainError);
  });

  it.each(['00', '01', '1.0', ' 1', '1 ', '1\n', '-1', '+1', '1e3'])(
    'rejects noncanonical wire amount %j',
    (input) => {
      expect(() => parseMinorUnits(input)).toThrow(DomainError);
    },
  );

  it('formats large amounts without float rounding', () => {
    expect(formatUsd(MAX_MINOR_UNITS)).toBe('$92,233,720,368,547,758.07');
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(1n)).toBe('$0.01');
  });

  it('round-trips every generated exact amount through display decimals and transport', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_MINOR_UNITS }), (amount) => {
        expect(parseUsd(formatDecimalUsd(amount))).toBe(amount);
        expect(parseMinorUnits(amount.toString())).toBe(amount);
      }),
      { numRuns: 500 },
    );
  });
});
