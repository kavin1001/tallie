import { randomUUID } from 'node:crypto';
import { buildObligations, type Allocation as DomainAllocation } from '@tallie/domain';
import type { Transaction } from 'kysely';
import type { Category, ExpenseItem, SplitMethod } from './contracts';
import type { Database } from './schema';

export interface PublishedExpense {
  workspaceId: string;
  paidById: string;
  title: string;
  emoji: string;
  category: Category;
  totalMinor: bigint;
  method: SplitMethod;
  allocations: readonly DomainAllocation[];
  items: ExpenseItem[];
  subtotalMinor: bigint;
  taxMinor: bigint;
  tipMinor: bigint;
  discountMinor: bigint;
  receiptKind: 'demo' | 'manual';
  createdAt?: Date;
}

/** Call only within a transaction; the deferred DB constraint checks conservation. */
export async function insertPublishedExpense(
  tx: Transaction<Database>,
  input: PublishedExpense,
): Promise<string> {
  const expenseId = randomUUID();
  const createdAt = input.createdAt ?? new Date();
  await tx
    .insertInto('expenses')
    .values({
      id: expenseId,
      workspace_id: input.workspaceId,
      paid_by_id: input.paidById,
      title: input.title,
      emoji: input.emoji,
      category: input.category,
      total_minor: input.totalMinor.toString(),
      method: input.method,
      items: JSON.stringify(input.items),
      subtotal_minor: input.subtotalMinor.toString(),
      tax_minor: input.taxMinor.toString(),
      tip_minor: input.tipMinor.toString(),
      discount_minor: input.discountMinor.toString(),
      receipt_kind: input.receiptKind,
      created_at: createdAt,
    })
    .execute();
  await tx
    .insertInto('expense_allocations')
    .values(
      input.allocations.map((share) => ({
        workspace_id: input.workspaceId,
        expense_id: expenseId,
        person_id: share.participantId,
        amount_minor: share.amountMinor.toString(),
      })),
    )
    .execute();
  await tx
    .updateTable('expenses')
    .set({ published_at: createdAt })
    .where('id', '=', expenseId)
    .execute();
  const obligations = buildObligations({
    payerParticipantId: input.paidById,
    allocations: input.allocations,
  });
  if (obligations.length > 0) {
    await tx
      .insertInto('payment_requests')
      .values(
        obligations.map((obligation) => ({
          id: randomUUID(),
          workspace_id: input.workspaceId,
          expense_id: expenseId,
          debtor_id: obligation.payerParticipantId,
          payee_id: obligation.payeeParticipantId,
          amount_minor: obligation.amountMinor.toString(),
          issue_reason: null,
          created_at: createdAt,
          updated_at: createdAt,
        })),
      )
      .execute();
  }
  await tx
    .insertInto('activity')
    .values(
      input.allocations.map((share) => ({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        user_id: share.participantId,
        person_id: input.paidById,
        expense_id: expenseId,
        operation_id: null,
        type: 'split_created' as const,
        title: input.title,
        description:
          share.participantId === input.paidById ? 'You shared a split' : 'A new split for you',
        emoji: input.emoji,
        amount_minor: share.amountMinor.toString(),
        created_at: createdAt,
      })),
    )
    .execute();
  return expenseId;
}
