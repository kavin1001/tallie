import { createHash, randomUUID } from 'node:crypto';
import { database, insertPublishedExpense, type Database } from '@tallie/db';
import type {
  CreateExpenseInput,
  ExpenseSummary,
  Operation,
  PaymentReview,
} from '@tallie/db/contracts';
import {
  allocateByItem,
  allocateCustom,
  allocateEqual,
  parseMinorUnits,
  type Allocation,
} from '@tallie/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AppError, notFound } from './errors';
import { getExpense, getOperation, getReview } from './queries';
import { lockSession, type Principal } from './session';

const REVIEW_LIFETIME_MS = 5 * 60 * 1_000;
const SIMULATION_DELAY_MS = 1_500;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function idempotentResource(
  tx: Transaction<Database>,
  principal: Principal,
  scope: string,
  key: string,
  input: unknown,
  create: () => Promise<string>,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This action needs a unique retry key.');
  // Serialize a key even before its row exists. Hash collisions only serialize
  // unrelated work; the full tenant/actor/scope/key remains the unique identity.
  const lockKey = `${principal.workspaceId}:${principal.personId}:${scope}:${key}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(tx);
  const hash = digest(input);
  const existing = await tx
    .selectFrom('api_idempotency')
    .selectAll()
    .where('workspace_id', '=', principal.workspaceId)
    .where('actor_id', '=', principal.personId)
    .where('scope', '=', scope)
    .where('key', '=', key)
    .executeTakeFirst();
  if (existing) {
    if (existing.request_hash !== hash)
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'This retry key belongs to a different action. Start a fresh review.',
        409,
      );
    return existing.resource_id;
  }
  const id = await create();
  await tx
    .insertInto('api_idempotency')
    .values({
      workspace_id: principal.workspaceId,
      actor_id: principal.personId,
      scope,
      key,
      request_hash: hash,
      resource_id: id,
    })
    .execute();
  return id;
}

export async function createExpense(
  principal: Principal,
  input: CreateExpenseInput,
  key: string,
  db: Kysely<Database> = database(),
): Promise<ExpenseSummary> {
  const expenseId = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    return idempotentResource(tx, principal, 'create_expense', key, input, async () => {
      if (!input.participantIds.includes(principal.personId))
        throw new AppError('PAYER_REQUIRED', 'Include your own share in the split.');
      if (
        input.participantIds.length < 2 ||
        new Set(input.participantIds).size !== input.participantIds.length
      ) {
        throw new AppError(
          'INVALID_PARTICIPANTS',
          'Choose at least one friend, with each person appearing once.',
        );
      }
      const people = await tx
        .selectFrom('people')
        .select('id')
        .where('workspace_id', '=', principal.workspaceId)
        .where('id', 'in', input.participantIds)
        .execute();
      if (people.length !== input.participantIds.length)
        throw new AppError('INVALID_PARTICIPANTS', 'Choose people from this private demo.');
      const total = parseMinorUnits(input.totalMinor);
      if (total === 0n || total > 10_000_000n)
        throw new AppError('INVALID_AMOUNT', 'Enter a total between $0.01 and $100,000.');
      const tax = parseMinorUnits(input.taxMinor ?? '0');
      const tip = parseMinorUnits(input.tipMinor ?? '0');
      const discount = parseMinorUnits(input.discountMinor ?? '0');
      let subtotal = total - tax - tip + discount;
      if (subtotal < 0n)
        throw new AppError('TOTAL_MISMATCH', 'Tax and tip cannot exceed this total.');
      let itemAllocations: readonly Allocation[] | undefined;
      if (input.items && input.items.length > 0) {
        const result = allocateByItem({
          participantIds: input.participantIds,
          items: input.items.map((item) => ({
            id: item.id,
            totalMinor: parseMinorUnits(item.amountMinor),
            participantIds: item.participantIds,
          })),
          taxMinor: tax,
          tipMinor: tip,
          discountMinor: discount,
          statedTotalMinor: total,
        });
        subtotal = result.subtotalMinor;
        itemAllocations = result.allocations;
      }
      let allocations: readonly Allocation[];
      switch (input.method) {
        case 'equal':
          allocations = allocateEqual(total, input.participantIds);
          break;
        case 'custom': {
          const shares = input.shares;
          if (
            !shares ||
            shares.length !== input.participantIds.length ||
            shares.some((share) => !input.participantIds.includes(share.participantId))
          ) {
            throw new AppError('INVALID_SHARES', 'Enter one share for every person in the split.');
          }
          allocations = allocateCustom(
            total,
            shares.map((share) => ({
              participantId: share.participantId,
              amountMinor: parseMinorUnits(share.amountMinor),
            })),
          );
          break;
        }
        case 'items':
          if (!itemAllocations || input.taxMinor === undefined || input.tipMinor === undefined) {
            throw new AppError(
              'ITEMS_REQUIRED',
              'Confirm the items, tax, and tip before sharing this split.',
            );
          }
          allocations = itemAllocations;
          break;
        default:
          throw new AppError('INVALID_METHOD', 'Choose how you want to split this expense.');
      }
      return insertPublishedExpense(tx, {
        workspaceId: principal.workspaceId,
        paidById: principal.personId,
        title: input.title,
        emoji: input.emoji,
        category: input.category,
        totalMinor: total,
        method: input.method,
        allocations,
        items: input.items ?? [],
        subtotalMinor: subtotal,
        taxMinor: tax,
        tipMinor: tip,
        discountMinor: discount,
        receiptKind: 'manual',
      });
    });
  });
  return getExpense(principal, expenseId, db);
}

interface ReviewTuple {
  payerId: string;
  payeeId: string;
  requestId: string | null;
  requestVersion: number | null;
  amountMinor: string;
  note: string;
  kind: 'request' | 'send';
}

async function insertReview(
  tx: Transaction<Database>,
  principal: Principal,
  tuple: ReviewTuple,
): Promise<string> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + REVIEW_LIFETIME_MS);
  const reviewDigest = digest({
    id,
    workspaceId: principal.workspaceId,
    sessionId: principal.sessionId,
    ...tuple,
    sourceId: 'demo-balance',
    feeMinor: '0',
    feePolicy: 'demo-zero-fee-v1',
    currency: 'USD',
    expiresAt: expiresAt.toISOString(),
  });
  await tx
    .insertInto('payment_reviews')
    .values({
      id,
      workspace_id: principal.workspaceId,
      session_id: principal.sessionId,
      payer_id: tuple.payerId,
      payee_id: tuple.payeeId,
      request_id: tuple.requestId,
      request_version: tuple.requestVersion,
      kind: tuple.kind,
      amount_minor: tuple.amountMinor,
      note: tuple.note,
      digest: reviewDigest,
      expires_at: expiresAt,
    })
    .execute();
  return id;
}

export async function reviewRequest(
  principal: Principal,
  requestId: string,
  db: Kysely<Database> = database(),
): Promise<PaymentReview> {
  const reviewId = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    const request = await tx
      .selectFrom('payment_requests')
      .selectAll()
      .where('workspace_id', '=', principal.workspaceId)
      .where('id', '=', requestId)
      .where('debtor_id', '=', principal.personId)
      .forUpdate()
      .executeTakeFirst();
    if (!request) notFound();
    if (request.status !== 'open')
      throw new AppError(
        'REQUEST_NOT_PAYABLE',
        'This request changed. Refresh it before continuing.',
        409,
      );
    const expense = await tx
      .selectFrom('expenses')
      .select('title')
      .where('id', '=', request.expense_id)
      .executeTakeFirstOrThrow();
    return insertReview(tx, principal, {
      payerId: principal.personId,
      payeeId: request.payee_id,
      requestId: request.id,
      requestVersion: request.version,
      amountMinor: request.amount_minor,
      note: expense.title,
      kind: 'request',
    });
  });
  return getReview(principal, reviewId, db);
}

export async function reviewSend(
  principal: Principal,
  input: { recipientId: string; amountMinor: string; note: string },
  db: Kysely<Database> = database(),
): Promise<PaymentReview> {
  const reviewId = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    if (input.recipientId === principal.personId)
      throw new AppError('SELF_PAYMENT', 'Choose a friend to send this to.');
    const recipient = await tx
      .selectFrom('people')
      .select('id')
      .where('workspace_id', '=', principal.workspaceId)
      .where('id', '=', input.recipientId)
      .executeTakeFirst();
    if (!recipient) notFound();
    const amount = parseMinorUnits(input.amountMinor);
    if (amount === 0n || amount > 10_000_000n)
      throw new AppError('INVALID_AMOUNT', 'Enter an amount between $0.01 and $100,000.');
    const overlap = await tx
      .selectFrom('payment_requests')
      .select('id')
      .where('workspace_id', '=', principal.workspaceId)
      .where('debtor_id', '=', principal.personId)
      .where('payee_id', '=', input.recipientId)
      .where('amount_minor', '=', amount.toString())
      .where('status', 'in', ['open', 'processing', 'issue'])
      .executeTakeFirst();
    if (overlap)
      throw new AppError(
        'EXISTING_REQUEST',
        'You already have a split for this exact amount with this person. Open that split to pay it.',
        409,
      );
    return insertReview(tx, principal, {
      payerId: principal.personId,
      payeeId: input.recipientId,
      requestId: null,
      requestVersion: null,
      amountMinor: amount.toString(),
      note: input.note,
      kind: 'send',
    });
  });
  return getReview(principal, reviewId, db);
}

export async function authorizeReview(
  principal: Principal,
  reviewId: string,
  reviewDigest: string,
  key: string,
  db: Kysely<Database> = database(),
): Promise<Operation> {
  const operationId = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    return idempotentResource(
      tx,
      principal,
      'authorize_payment',
      key,
      { reviewId, reviewDigest },
      async () => {
        const review = await tx
          .selectFrom('payment_reviews')
          .selectAll()
          .where('workspace_id', '=', principal.workspaceId)
          .where('id', '=', reviewId)
          .where('payer_id', '=', principal.personId)
          .where('session_id', '=', principal.sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!review) notFound();
        if (review.digest !== reviewDigest)
          throw new AppError(
            'REVIEW_CHANGED',
            'This review changed. Check the latest amount and recipient.',
            409,
          );
        if (review.expires_at.getTime() <= Date.now())
          throw new AppError(
            'REVIEW_EXPIRED',
            'This review expired. Review the payment again.',
            409,
          );
        const consumed = await tx
          .selectFrom('payment_consents')
          .select('id')
          .where('review_id', '=', review.id)
          .executeTakeFirst();
        if (consumed)
          throw new AppError(
            'REVIEW_ALREADY_USED',
            'This approval already has a payment. Check its status.',
            409,
          );
        if (review.request_id) {
          const request = await tx
            .selectFrom('payment_requests')
            .selectAll()
            .where('workspace_id', '=', principal.workspaceId)
            .where('id', '=', review.request_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (request.status !== 'open' || request.version !== review.request_version) {
            throw new AppError(
              'VERSION_CONFLICT',
              'This split changed after you reviewed it. Refresh and review it again.',
              409,
            );
          }
          await tx
            .updateTable('payment_requests')
            .set({ status: 'processing', version: sql`version + 1`, updated_at: new Date() })
            .where('id', '=', request.id)
            .execute();
        } else {
          // Recheck the ambiguity guard at approval, not just when the review was made.
          const overlap = await tx
            .selectFrom('payment_requests')
            .select('id')
            .where('workspace_id', '=', principal.workspaceId)
            .where('debtor_id', '=', principal.personId)
            .where('payee_id', '=', review.payee_id)
            .where('amount_minor', '=', review.amount_minor)
            .where('status', 'in', ['open', 'processing', 'issue'])
            .executeTakeFirst();
          if (overlap)
            throw new AppError(
              'EXISTING_REQUEST',
              'There is now a matching split. Review that request before sending a separate payment.',
              409,
            );
        }
        const consentId = randomUUID();
        const id = randomUUID();
        await tx
          .insertInto('payment_consents')
          .values({
            id: consentId,
            workspace_id: principal.workspaceId,
            review_id: review.id,
            session_id: principal.sessionId,
            actor_id: principal.personId,
            review_digest: review.digest,
          })
          .execute();
        await tx
          .insertInto('operations')
          .values({
            id,
            workspace_id: principal.workspaceId,
            review_id: review.id,
            consent_id: consentId,
            payer_id: review.payer_id,
            payee_id: review.payee_id,
            request_id: review.request_id,
            kind: review.kind,
            amount_minor: review.amount_minor,
            note: review.note,
            ready_at: new Date(Date.now() + SIMULATION_DELAY_MS),
            completed_at: null,
          })
          .execute();
        return id;
      },
    );
  });
  return getOperation(principal, operationId, db);
}

export async function changeRequest(
  principal: Principal,
  requestId: string,
  input:
    | { expectedVersion: number; action: 'cancel' }
    | { expectedVersion: number; action: 'issue'; reason: string },
  db: Kysely<Database> = database(),
): Promise<ExpenseSummary> {
  const expenseId = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    const request = await tx
      .selectFrom('payment_requests')
      .selectAll()
      .where('workspace_id', '=', principal.workspaceId)
      .where('id', '=', requestId)
      .where(input.action === 'cancel' ? 'payee_id' : 'debtor_id', '=', principal.personId)
      .forUpdate()
      .executeTakeFirst();
    if (!request) notFound();
    if (request.version !== input.expectedVersion)
      throw new AppError(
        'VERSION_CONFLICT',
        'This request changed. Refresh it before continuing.',
        409,
      );
    const eligible = input.action === 'cancel' ? ['open', 'issue'] : ['open'];
    if (!eligible.includes(request.status))
      throw new AppError(
        'REQUEST_NOT_EDITABLE',
        'This request is already processing or closed.',
        409,
      );
    await tx
      .updateTable('payment_requests')
      .set({
        status: input.action === 'cancel' ? 'canceled' : 'issue',
        issue_reason: input.action === 'issue' ? input.reason : request.issue_reason,
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', request.id)
      .execute();
    const expense = await tx
      .selectFrom('expenses')
      .select(['title', 'emoji'])
      .where('id', '=', request.expense_id)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('activity')
      .values(
        [request.debtor_id, request.payee_id].map((userId) => ({
          id: randomUUID(),
          workspace_id: principal.workspaceId,
          user_id: userId,
          person_id: principal.personId,
          expense_id: request.expense_id,
          operation_id: null,
          type:
            input.action === 'cancel' ? ('request_canceled' as const) : ('issue_raised' as const),
          title: expense.title,
          description:
            input.action === 'cancel' ? 'Request canceled' : 'A question about this split',
          emoji: expense.emoji,
          amount_minor: request.amount_minor,
        })),
      )
      .execute();
    return request.expense_id;
  });
  return getExpense(principal, expenseId, db);
}
