import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DomainError,
  MAX_MINOR_UNITS,
  allocateByItem,
  allocateCustom,
  allocateEqual,
  allocateProportional,
  buildObligations,
  type ItemSplitInput,
} from '../src';

const dinner: ItemSplitInput = {
  participantIds: ['maya', 'leo', 'alex'],
  items: [
    { id: 'food', totalMinor: 6000n, participantIds: ['alex', 'maya', 'leo'] },
    { id: 'wine', totalMinor: 3000n, participantIds: ['alex', 'leo'] },
  ],
  taxMinor: 900n,
  tipMinor: 1800n,
  statedTotalMinor: 11700n,
};

describe('deterministic allocations', () => {
  it('gives a tied cent to the stable ID regardless of insertion order', () => {
    const expected = [
      { participantId: 'a', amountMinor: 334n },
      { participantId: 'b', amountMinor: 333n },
      { participantId: 'c', amountMinor: 333n },
    ];
    expect(allocateEqual(1000n, ['c', 'a', 'b'])).toEqual(expected);
    expect(allocateEqual(1000n, ['b', 'c', 'a'])).toEqual(expected);
  });

  it('uses exact remainders even for products beyond safe floating point', () => {
    const result = allocateProportional(MAX_MINOR_UNITS, [
      { participantId: 'a', weight: MAX_MINOR_UNITS },
      { participantId: 'b', weight: MAX_MINOR_UNITS - 1n },
    ]);
    expect(result).toEqual([
      { participantId: 'a', amountMinor: 4611686018427387904n },
      { participantId: 'b', amountMinor: 4611686018427387903n },
    ]);
  });

  it('preserves the total, nonnegative shares, and one-cent fairness for equal splitting', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_MINOR_UNITS }),
        fc.integer({ min: 1, max: 20 }),
        (total, count) => {
          const ids = Array.from(
            { length: count },
            (_, index) => `p-${index.toString().padStart(2, '0')}`,
          );
          const shares = allocateEqual(total, ids);
          expect(shares.reduce((sum, share) => sum + share.amountMinor, 0n)).toBe(total);
          for (const share of shares) {
            expect(share.amountMinor >= total / BigInt(count)).toBe(true);
            expect(share.amountMinor <= total / BigInt(count) + 1n).toBe(true);
          }
          expect(allocateEqual(total, [...ids].reverse())).toEqual(shares);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('obeys exact quota bounds and conserves cents for arbitrary positive weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_MINOR_UNITS }),
        fc
          .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 20 })
          .filter((weights) => weights.some((weight) => weight > 0n)),
        (total, weights) => {
          const participants = weights.map((weight, index) => ({
            participantId: `p-${index}`,
            weight,
          }));
          const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
          const shares = allocateProportional(total, participants);
          expect(shares.reduce((sum, share) => sum + share.amountMinor, 0n)).toBe(total);
          for (const participant of participants) {
            const share = shares.find(
              ({ participantId }) => participantId === participant.participantId,
            )!;
            const numerator = total * participant.weight;
            const floor = numerator / denominator;
            const ceiling = (numerator + denominator - 1n) / denominator;
            expect(share.amountMinor >= floor && share.amountMinor <= ceiling).toBe(true);
          }
          expect(allocateProportional(total, [...participants].reverse())).toEqual(shares);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects duplicate identities, including zero shares', () => {
    expect(() => allocateEqual(100n, ['a', 'a'])).toThrow(DomainError);
    expect(() =>
      allocateCustom(100n, [
        { participantId: 'a', amountMinor: 100n },
        { participantId: 'a', amountMinor: 0n },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARTICIPANTS' }));
  });

  it('rejects missing identities, negative money, too many people, and unexplained custom remainder', () => {
    expect(() => allocateEqual(100n, [])).toThrow(DomainError);
    expect(() => allocateEqual(100n, [' '])).toThrow(DomainError);
    expect(() => allocateEqual(-1n, ['a'])).toThrow(DomainError);
    expect(() =>
      allocateEqual(
        100n,
        Array.from({ length: 21 }, (_, index) => `${index}`),
      ),
    ).toThrow(DomainError);
    expect(() => allocateCustom(100n, [{ participantId: 'a', amountMinor: 99n }])).toThrow(
      expect.objectContaining({ code: 'ALLOCATION_MISMATCH' }),
    );
  });

  it("returns immutable snapshots without freezing or mutating the caller's draft", () => {
    const input = [
      { participantId: 'b', amountMinor: 50n },
      { participantId: 'a', amountMinor: 50n },
    ];
    const result = allocateCustom(100n, input);
    input[0]!.amountMinor = 80n;
    expect(result).toEqual([
      { participantId: 'a', amountMinor: 50n },
      { participantId: 'b', amountMinor: 50n },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });
});

describe('item splitting', () => {
  it('reconciles the $117 dinner with wine excluded for Maya', () => {
    const result = allocateByItem(dinner);
    expect(result.allocations).toEqual([
      { participantId: 'alex', amountMinor: 4550n },
      { participantId: 'leo', amountMinor: 4550n },
      { participantId: 'maya', amountMinor: 2600n },
    ]);
    expect(result.breakdown.find(({ participantId }) => participantId === 'maya')).toMatchObject({
      itemsMinor: 2000n,
      taxMinor: 200n,
      tipMinor: 400n,
      discountMinor: 0n,
      itemShares: [{ itemId: 'food', amountMinor: 2000n }],
    });
    expect(result.tieBreakOrder).toEqual(['alex', 'leo', 'maya']);
    expect(result.algorithmVersion).toBe('usd-largest-remainder-v1');
  });

  it('handles receipt discounts before proportionally allocating service, tax, and tip', () => {
    const result = allocateByItem({
      participantIds: ['a', 'b'],
      items: [
        { id: 'a-item', totalMinor: 300n, participantIds: ['a'] },
        { id: 'b-item', totalMinor: 700n, participantIds: ['b'] },
      ],
      discountMinor: 100n,
      taxMinor: 90n,
      tipMinor: 180n,
      serviceChargeMinor: 90n,
      statedTotalMinor: 1260n,
    });
    expect(result.allocations).toEqual([
      { participantId: 'a', amountMinor: 378n },
      { participantId: 'b', amountMinor: 882n },
    ]);
  });

  it('honors an explicit equal-tip override without changing item or tax allocation', () => {
    const result = allocateByItem({ ...dinner, tipRule: 'equal' });
    expect(result.allocations).toEqual([
      { participantId: 'alex', amountMinor: 4450n },
      { participantId: 'leo', amountMinor: 4450n },
      { participantId: 'maya', amountMinor: 2800n },
    ]);
  });

  it('does not invent an allocation basis after a full discount', () => {
    const input: ItemSplitInput = {
      participantIds: ['a', 'b'],
      items: [{ id: 'food', totalMinor: 100n, participantIds: ['a', 'b'] }],
      discountMinor: 100n,
      taxMinor: 0n,
      tipMinor: 20n,
      statedTotalMinor: 20n,
    };
    expect(() => allocateByItem(input)).toThrow(
      expect.objectContaining({ code: 'ALLOCATION_MISMATCH' }),
    );
    expect(allocateByItem({ ...input, tipRule: 'equal' }).allocations).toEqual([
      { participantId: 'a', amountMinor: 10n },
      { participantId: 'b', amountMinor: 10n },
    ]);
  });

  it('rejects unreconciled totals instead of adding a hidden balancing amount', () => {
    expect(() => allocateByItem({ ...dinner, statedTotalMinor: 11701n })).toThrow(
      expect.objectContaining({ code: 'TOTAL_MISMATCH' }),
    );
    expect(() => allocateByItem({ ...dinner, discountMinor: 9001n })).toThrow(
      expect.objectContaining({ code: 'INVALID_DISCOUNT' }),
    );
    expect(() => allocateByItem({ ...dinner, items: [...dinner.items, dinner.items[0]!] })).toThrow(
      expect.objectContaining({ code: 'INVALID_ITEMS' }),
    );
    expect(() =>
      allocateByItem({
        ...dinner,
        items: [{ id: 'x', totalMinor: 9000n, participantIds: ['stranger'] }],
      }),
    ).toThrow(DomainError);
  });

  it('requires both explicit tax and tip, so undefined is never interpreted as zero', () => {
    const unresolved = { ...dinner, tipMinor: undefined } as unknown as ItemSplitInput;
    expect(() => allocateByItem(unresolved)).toThrow(
      expect.objectContaining({ code: 'INVALID_AMOUNT' }),
    );
  });

  it('keeps independently rounded breakdown columns and final shares exactly reconciled', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (itemAmounts, tax, tip) => {
          const participantIds = itemAmounts.map((_, index) => `p-${index}`);
          const subtotal = itemAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
          const result = allocateByItem({
            participantIds,
            items: itemAmounts.map((amount, index) => ({
              id: `item-${index}`,
              totalMinor: BigInt(amount),
              participantIds: [participantIds[index]!],
            })),
            taxMinor: BigInt(tax),
            tipMinor: BigInt(tip),
            statedTotalMinor: subtotal + BigInt(tax + tip),
          });
          expect(result.allocations.reduce((sum, share) => sum + share.amountMinor, 0n)).toBe(
            result.totalMinor,
          );
          expect(result.breakdown.reduce((sum, share) => sum + share.taxMinor, 0n)).toBe(
            BigInt(tax),
          );
          expect(result.breakdown.reduce((sum, share) => sum + share.tipMinor, 0n)).toBe(
            BigInt(tip),
          );
          for (const share of result.breakdown) {
            expect(share.amountMinor).toBe(
              share.itemsMinor -
                share.discountMinor +
                share.serviceChargeMinor +
                share.taxMinor +
                share.tipMinor,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('request obligations', () => {
  it("creates only positive debts to the original payer, preserving everyone's actual share", () => {
    expect(
      buildObligations({
        payerParticipantId: 'alex',
        allocations: allocateByItem(dinner).allocations,
      }),
    ).toEqual([
      { payerParticipantId: 'leo', payeeParticipantId: 'alex', amountMinor: 4550n },
      { payerParticipantId: 'maya', payeeParticipantId: 'alex', amountMinor: 2600n },
    ]);
    expect(
      buildObligations({
        payerParticipantId: 'a',
        allocations: [
          { participantId: 'a', amountMinor: 100n },
          { participantId: 'b', amountMinor: 0n },
        ],
      }),
    ).toEqual([]);
  });

  it('requires an explicit original payer share and never aliases duplicate participants', () => {
    expect(() =>
      buildObligations({
        payerParticipantId: 'a',
        allocations: [{ participantId: 'b', amountMinor: 100n }],
      }),
    ).toThrow(DomainError);
    expect(() =>
      buildObligations({
        payerParticipantId: 'a',
        allocations: [
          { participantId: 'a', amountMinor: 50n },
          { participantId: 'a', amountMinor: 50n },
        ],
      }),
    ).toThrow(DomainError);
  });
});
