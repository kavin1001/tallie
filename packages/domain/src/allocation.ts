import { DomainError } from './errors';
import { assertMinorUnits } from './money';

export const ALLOCATION_VERSION = 'usd-largest-remainder-v1' as const;
export const MAX_PARTICIPANTS = 20;
export const MAX_RECEIPT_ITEMS = 200;

export interface Allocation {
  readonly participantId: string;
  readonly amountMinor: bigint;
}

export interface WeightedParticipant {
  readonly participantId: string;
  readonly weight: bigint;
}

export type AdjustmentRule = 'proportional' | 'equal';

export interface SplitItem {
  readonly id: string;
  /** The confirmed line total after any line discount, with quantity already accounted for. */
  readonly totalMinor: bigint;
  readonly participantIds: readonly string[];
}

export interface ItemSplitInput {
  readonly participantIds: readonly string[];
  readonly items: readonly SplitItem[];
  /** Required: an unreadable tax or tip must be resolved by the caller, not defaulted to zero. */
  readonly taxMinor: bigint;
  readonly tipMinor: bigint;
  readonly statedTotalMinor: bigint;
  readonly discountMinor?: bigint;
  readonly serviceChargeMinor?: bigint;
  readonly taxRule?: AdjustmentRule;
  readonly tipRule?: AdjustmentRule;
}

export interface ItemShare {
  readonly itemId: string;
  readonly amountMinor: bigint;
}

export interface ParticipantBreakdown extends Allocation {
  readonly itemsMinor: bigint;
  readonly discountMinor: bigint;
  readonly serviceChargeMinor: bigint;
  readonly taxMinor: bigint;
  readonly tipMinor: bigint;
  readonly itemShares: readonly ItemShare[];
}

export interface SplitResult {
  readonly algorithmVersion: typeof ALLOCATION_VERSION;
  readonly tieBreakOrder: readonly string[];
  readonly allocations: readonly Allocation[];
  readonly breakdown: readonly ParticipantBreakdown[];
  readonly subtotalMinor: bigint;
  readonly totalMinor: bigint;
}

export interface Obligation {
  /** The participant who owes the original payer, not the person who paid the receipt. */
  readonly payerParticipantId: string;
  readonly payeeParticipantId: string;
  readonly amountMinor: bigint;
}

function compareIds(left: string, right: string): number {
  // Locale-independent UTF-16 ordering. Do not replace with localeCompare: it can vary by host.
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateParticipantIds(ids: readonly string[]): readonly string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PARTICIPANTS) {
    throw new DomainError('INVALID_PARTICIPANTS', 'Choose between one and twenty participants.');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 128 ||
      id.trim() !== id ||
      seen.has(id)
    ) {
      throw new DomainError(
        'INVALID_PARTICIPANTS',
        'Participants must have distinct, stable identifiers.',
      );
    }
    seen.add(id);
  }
  return Object.freeze([...ids].sort(compareIds));
}

function freezeAllocations(allocations: readonly Allocation[]): readonly Allocation[] {
  return Object.freeze(
    allocations.map(({ participantId, amountMinor }) =>
      Object.freeze({ participantId, amountMinor }),
    ),
  );
}

/** Exact largest-remainder allocation; ties use stable IDs, never input ordering or names. */
export function allocateProportional(
  totalMinor: bigint,
  participants: readonly WeightedParticipant[],
): readonly Allocation[] {
  assertMinorUnits(totalMinor);
  validateParticipantIds(participants.map((participant) => participant.participantId));
  for (const participant of participants) assertMinorUnits(participant.weight);
  const totalWeight = participants.reduce((sum, participant) => sum + participant.weight, 0n);
  if (totalWeight === 0n) {
    if (totalMinor !== 0n) {
      throw new DomainError(
        'ALLOCATION_MISMATCH',
        'A positive adjustment needs an explicit allocation basis.',
      );
    }
    return freezeAllocations(
      participants
        .map(({ participantId }) => ({ participantId, amountMinor: 0n }))
        .sort((left, right) => compareIds(left.participantId, right.participantId)),
    );
  }
  const parts = participants.map(({ participantId, weight }) => ({
    participantId,
    amountMinor: (totalMinor * weight) / totalWeight,
    remainder: (totalMinor * weight) % totalWeight,
  }));
  let remainder = totalMinor - parts.reduce((sum, part) => sum + part.amountMinor, 0n);
  parts.sort((left, right) =>
    left.remainder === right.remainder
      ? compareIds(left.participantId, right.participantId)
      : left.remainder > right.remainder
        ? -1
        : 1,
  );
  for (const part of parts) {
    if (remainder === 0n) break;
    part.amountMinor += 1n;
    remainder -= 1n;
  }
  return freezeAllocations(
    parts
      .sort((left, right) => compareIds(left.participantId, right.participantId))
      .map(({ participantId, amountMinor }) => ({ participantId, amountMinor })),
  );
}

export function allocateEqual(
  totalMinor: bigint,
  participantIds: readonly string[],
): readonly Allocation[] {
  validateParticipantIds(participantIds);
  return allocateProportional(
    totalMinor,
    participantIds.map((participantId) => ({ participantId, weight: 1n })),
  );
}

export function allocateCustom(
  totalMinor: bigint,
  shares: readonly Allocation[],
): readonly Allocation[] {
  assertMinorUnits(totalMinor);
  validateParticipantIds(shares.map((share) => share.participantId));
  for (const share of shares) assertMinorUnits(share.amountMinor);
  if (shares.reduce((sum, share) => sum + share.amountMinor, 0n) !== totalMinor) {
    throw new DomainError(
      'ALLOCATION_MISMATCH',
      "Everyone's shares must add up to the exact total.",
    );
  }
  return freezeAllocations(
    [...shares].sort((left, right) => compareIds(left.participantId, right.participantId)),
  );
}

function applyRule(
  totalMinor: bigint,
  weights: readonly WeightedParticipant[],
  rule: AdjustmentRule,
): ReadonlyMap<string, bigint> {
  if (rule !== 'equal' && rule !== 'proportional') {
    throw new DomainError('INVALID_RULE', 'Choose an equal or proportional adjustment rule.');
  }
  const allocations =
    rule === 'equal'
      ? allocateEqual(
          totalMinor,
          weights.map(({ participantId }) => participantId),
        )
      : allocateProportional(totalMinor, weights);
  return new Map(allocations.map(({ participantId, amountMinor }) => [participantId, amountMinor]));
}

/** Receipt totals must already be reconciled. This function never fabricates a balancing item. */
export function allocateByItem(input: ItemSplitInput): SplitResult {
  const participantIds = validateParticipantIds(input.participantIds);
  const participantSet = new Set(participantIds);
  if (
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > MAX_RECEIPT_ITEMS
  ) {
    throw new DomainError(
      'INVALID_ITEMS',
      'A receipt needs between one and two hundred resolved items.',
    );
  }
  assertMinorUnits(input.taxMinor);
  assertMinorUnits(input.tipMinor);
  assertMinorUnits(input.statedTotalMinor, false);
  const discountMinor = input.discountMinor ?? 0n;
  const serviceChargeMinor = input.serviceChargeMinor ?? 0n;
  assertMinorUnits(discountMinor);
  assertMinorUnits(serviceChargeMinor);

  const itemIds = new Set<string>();
  const itemShares = new Map<string, ItemShare[]>(participantIds.map((id) => [id, []]));
  let subtotalMinor = 0n;
  for (const item of input.items as readonly SplitItem[]) {
    if (
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      item.id.length > 128 ||
      item.id.trim() !== item.id ||
      itemIds.has(item.id)
    ) {
      throw new DomainError(
        'INVALID_ITEMS',
        'Receipt items must have distinct, stable identifiers.',
      );
    }
    itemIds.add(item.id);
    assertMinorUnits(item.totalMinor);
    validateParticipantIds(item.participantIds);
    if (item.participantIds.some((id) => !participantSet.has(id))) {
      throw new DomainError(
        'INVALID_PARTICIPANTS',
        'Every item must be assigned to receipt participants.',
      );
    }
    subtotalMinor += item.totalMinor;
    for (const share of allocateEqual(item.totalMinor, item.participantIds)) {
      itemShares
        .get(share.participantId)
        ?.push(Object.freeze({ itemId: item.id, amountMinor: share.amountMinor }));
    }
  }
  assertMinorUnits(subtotalMinor);
  if (discountMinor > subtotalMinor) {
    throw new DomainError(
      'INVALID_DISCOUNT',
      'The receipt discount cannot exceed the item subtotal.',
    );
  }
  const totalMinor =
    subtotalMinor - discountMinor + serviceChargeMinor + input.taxMinor + input.tipMinor;
  assertMinorUnits(totalMinor, false);
  if (totalMinor !== input.statedTotalMinor) {
    throw new DomainError(
      'TOTAL_MISMATCH',
      'Items and adjustments must match the confirmed receipt total.',
    );
  }

  const itemWeights = participantIds.map((participantId) => ({
    participantId,
    weight: (itemShares.get(participantId) ?? []).reduce(
      (sum, share) => sum + share.amountMinor,
      0n,
    ),
  }));
  const discounts = applyRule(discountMinor, itemWeights, 'proportional');
  const netWeights = itemWeights.map(({ participantId, weight }) => ({
    participantId,
    weight: weight - (discounts.get(participantId) ?? 0n),
  }));
  const tax = applyRule(input.taxMinor, netWeights, input.taxRule ?? 'proportional');
  const tip = applyRule(input.tipMinor, netWeights, input.tipRule ?? 'proportional');
  const service = applyRule(serviceChargeMinor, netWeights, 'proportional');
  const breakdown = Object.freeze(
    itemWeights.map(({ participantId, weight }) => {
      const discount = discounts.get(participantId) ?? 0n;
      const taxAmount = tax.get(participantId) ?? 0n;
      const tipAmount = tip.get(participantId) ?? 0n;
      const serviceAmount = service.get(participantId) ?? 0n;
      return Object.freeze({
        participantId,
        itemsMinor: weight,
        discountMinor: discount,
        taxMinor: taxAmount,
        tipMinor: tipAmount,
        serviceChargeMinor: serviceAmount,
        amountMinor: weight - discount + taxAmount + tipAmount + serviceAmount,
        itemShares: Object.freeze(
          [...(itemShares.get(participantId) ?? [])].sort((left, right) =>
            compareIds(left.itemId, right.itemId),
          ),
        ),
      });
    }),
  );

  return Object.freeze({
    algorithmVersion: ALLOCATION_VERSION,
    tieBreakOrder: participantIds,
    subtotalMinor,
    totalMinor,
    allocations: allocateCustom(totalMinor, breakdown),
    breakdown,
  });
}

export function buildObligations(input: {
  readonly payerParticipantId: string;
  readonly allocations: readonly Allocation[];
}): readonly Obligation[] {
  const ids = validateParticipantIds(
    input.allocations.map((allocation) => allocation.participantId),
  );
  if (!ids.includes(input.payerParticipantId)) {
    throw new DomainError(
      'INVALID_PARTICIPANTS',
      'The original payer must have an explicit share.',
    );
  }
  for (const allocation of input.allocations) assertMinorUnits(allocation.amountMinor);
  return Object.freeze(
    input.allocations
      .filter(
        (allocation) =>
          allocation.participantId !== input.payerParticipantId && allocation.amountMinor > 0n,
      )
      .sort((left, right) => compareIds(left.participantId, right.participantId))
      .map(({ participantId, amountMinor }) =>
        Object.freeze({
          payerParticipantId: participantId,
          payeeParticipantId: input.payerParticipantId,
          amountMinor,
        }),
      ),
  );
}
