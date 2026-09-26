import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { Insertable, Kysely } from 'kysely';
import {
  completeSimulatedOperation,
  createDatabase,
  createDemoWorkspace,
  processDueSimulatedOperations,
  tokenHash,
  type Database,
} from '@tallie/db';
import type { CreateExpenseInput } from '@tallie/db/contracts';
import { migrate } from '../../../../packages/db/src/migrate';
import {
  authorizeReview,
  changeRequest,
  createExpense,
  reviewRequest,
  reviewSend,
} from './commands';
import { getDashboard, getExpense, getExpenseDetail, getOperation } from './queries';
import { resolveSession, switchDemoPersona, type Principal } from './session';

config({ quiet: true });

describe('PostgreSQL application invariants', () => {
  let db: Kysely<Database>;
  let admin: Pool;
  const schema = `tallie_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection)
      throw new Error(
        'PostgreSQL integration tests require DATABASE_URL. Run npm run db:up first.',
      );
    const url = new URL(connection);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error(
        'Integration tests only create disposable schemas in a local PostgreSQL server.',
      );
    process.env.APP_MODE = 'demo';
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString());
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function fixture() {
    const session = await createDemoWorkspace(db);
    const principal = await resolveSession(session.token, db);
    const dashboard = await getDashboard(principal, db);
    const maya = dashboard.people.find((person) => person.firstName === 'Maya');
    const leo = dashboard.people.find((person) => person.firstName === 'Leo');
    const jamie = dashboard.people.find((person) => person.firstName === 'Jamie');
    if (!maya || !leo || !jamie) throw new Error('Synthetic fixture incomplete.');
    return { ...session, principal, dashboard, maya, leo, jamie };
  }

  async function sibling(principal: Principal, personId: string): Promise<Principal> {
    const sessionId = randomUUID();
    await db
      .insertInto('demo_sessions')
      .values({
        id: sessionId,
        token_hash: tokenHash(randomBytes(32).toString('base64url')),
        workspace_id: principal.workspaceId,
        person_id: personId,
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
      })
      .execute();
    return { ...principal, sessionId, personId };
  }

  async function queuedPayment() {
    const data = await fixture();
    const request = data.dashboard.requests.find(
      (entry) => entry.to.id === data.principal.personId && entry.status === 'open',
    );
    if (!request) throw new Error('Missing payable request.');
    const review = await reviewRequest(data.principal, request.id, db);
    const operation = await authorizeReview(
      data.principal,
      review.id,
      review.reviewDigest,
      randomUUID(),
      db,
    );
    await db
      .updateTable('operations')
      .set({ ready_at: new Date(Date.now() - 1_000) })
      .where('id', '=', operation.id)
      .execute();
    return { ...data, request, review, operation };
  }

  it('seeds the $117 receipt with exact shares and real ownership', async () => {
    const { dashboard, principal, maya, leo } = await fixture();
    const dinner = dashboard.expenses.find((expense) => expense.title === 'Friday at Lilia');
    expect(
      dinner?.participants.find((share) => share.person.id === principal.personId)?.amountMinor,
    ).toBe('4550');
    expect(dinner?.participants.find((share) => share.person.id === maya.id)?.amountMinor).toBe(
      '2600',
    );
    expect(dinner?.participants.find((share) => share.person.id === leo.id)?.amountMinor).toBe(
      '4550',
    );
    expect(
      dashboard.requests
        .filter((request) => request.expenseId === dinner?.id)
        .reduce((sum, request) => sum + BigInt(request.amountMinor), 0n),
    ).toBe(7150n);
    expect(dashboard.summary).toEqual({
      owedToYouMinor: '43150',
      owingMinor: '2545',
      settledMinor: '3600',
    });
  });

  it('isolates visitor workspaces and enforces expense participant access', async () => {
    const [a, b] = await Promise.all([fixture(), fixture()]);
    const expense = a.dashboard.expenses.find((entry) => entry.category === 'dinner');
    expect(expense).toBeDefined();
    await expect(getExpense(b.principal, expense!.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(switchDemoPersona(a.principal, b.maya.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const jamie = await sibling(a.principal, a.jamie.id);
    await expect(getExpense(jamie, expense!.id, db)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns complete per-person balances in both directions beyond the 200-request window', async () => {
    const { principal, dashboard } = await fixture();
    const friends = dashboard.people.filter((person) => person.id !== principal.personId);
    const countPerDirection = 202;
    const expected = new Map(friends.map((person) => [person.id, { owed: 0n, owing: 0n }]));
    for (const request of dashboard.requests) {
      if (!['open', 'processing', 'issue'].includes(request.status)) continue;
      const incoming = request.from.id === principal.personId;
      const balance = expected.get(incoming ? request.to.id : request.from.id)!;
      if (incoming) balance.owed += BigInt(request.amountMinor);
      else balance.owing += BigInt(request.amountMinor);
    }

    const expenses: Insertable<Database['expenses']>[] = [];
    const allocations: Insertable<Database['expense_allocations']>[] = [];
    const requests: Insertable<Database['payment_requests']>[] = [];
    for (const [index, friend] of friends.entries()) {
      for (const direction of ['owed', 'owing'] as const) {
        const share = BigInt(direction === 'owed' ? 101 + index : 211 + index);
        expected.get(friend.id)![direction] += share * BigInt(countPerDirection);
        for (let item = 0; item < countPerDirection + 2; item += 1) {
          const id = randomUUID();
          const payeeId = direction === 'owed' ? principal.personId : friend.id;
          const debtorId = direction === 'owed' ? friend.id : principal.personId;
          expenses.push({
            id,
            workspace_id: principal.workspaceId,
            paid_by_id: payeeId,
            title: 'Balance regression fixture',
            emoji: '☕',
            category: 'coffee',
            total_minor: (share * 2n).toString(),
            method: 'equal',
            items: '[]',
            subtotal_minor: (share * 2n).toString(),
            receipt_kind: 'manual',
          });
          allocations.push(
            {
              workspace_id: principal.workspaceId,
              expense_id: id,
              person_id: payeeId,
              amount_minor: share.toString(),
            },
            {
              workspace_id: principal.workspaceId,
              expense_id: id,
              person_id: debtorId,
              amount_minor: share.toString(),
            },
          );
          requests.push({
            id: randomUUID(),
            workspace_id: principal.workspaceId,
            expense_id: id,
            debtor_id: debtorId,
            payee_id: payeeId,
            amount_minor: share.toString(),
            issue_reason: null,
            status:
              item === countPerDirection
                ? 'paid'
                : item === countPerDirection + 1
                  ? 'canceled'
                  : (['open', 'processing', 'issue'] as const)[item % 3]!,
          });
        }
      }
    }
    const zeroFriend = randomUUID();
    await db.transaction().execute(async (tx) => {
      // Batch raw fixture construction exercises the real publication constraints
      // without spending time sending 1,632 separate HTTP-like commands.
      await tx.insertInto('expenses').values(expenses).execute();
      await tx.insertInto('expense_allocations').values(allocations).execute();
      await tx
        .updateTable('expenses')
        .set({ published_at: new Date() })
        .where(
          'id',
          'in',
          expenses.map((expense) => expense.id),
        )
        .execute();
      await tx.insertInto('payment_requests').values(requests).execute();
      await tx
        .insertInto('people')
        .values({
          id: zeroFriend,
          workspace_id: principal.workspaceId,
          name: 'No Balance',
          initials: 'NB',
          color: 'sage',
          venmo_handle: null,
        })
        .execute();
    });

    const result = await getDashboard(principal, db);
    expect(result.requests).toHaveLength(200);
    const olderExpense = dashboard.expenses.find((expense) => expense.category === 'dinner')!;
    expect(result.requests.some((request) => request.expenseId === olderExpense.id)).toBe(false);
    expect(result.expenses.some((expense) => expense.id === olderExpense.id)).toBe(false);
    const detail = await getExpenseDetail(principal, olderExpense.id, db);
    expect(detail.expense.id).toBe(olderExpense.id);
    expect(detail.requests.map((request) => request.id).sort()).toEqual(
      dashboard.requests
        .filter((request) => request.expenseId === olderExpense.id)
        .map((request) => request.id)
        .sort(),
    );
    expect(
      detail.requests.every((request) => request.allowedActions.includes('cancel_request')),
    ).toBe(true);
    expect(result.personBalances).toHaveLength(friends.length + 1);
    for (const friend of friends) {
      const expectedBalance = expected.get(friend.id)!;
      expect(result.personBalances.find((balance) => balance.personId === friend.id)).toEqual({
        personId: friend.id,
        owedToYouMinor: expectedBalance.owed.toString(),
        owingMinor: expectedBalance.owing.toString(),
      });
    }
    expect(result.personBalances.find((balance) => balance.personId === zeroFriend)).toEqual({
      personId: zeroFriend,
      owedToYouMinor: '0',
      owingMinor: '0',
    });
    expect(result.personBalances.some((balance) => balance.personId === principal.personId)).toBe(
      false,
    );
    expect(result.summary.owedToYouMinor).toBe(
      [...expected.values()].reduce((total, balance) => total + balance.owed, 0n).toString(),
    );
    expect(result.summary.owingMinor).toBe(
      [...expected.values()].reduce((total, balance) => total + balance.owing, 0n).toString(),
    );
  });

  it('keeps expense request details scoped to the current payer/payee while sharing allocations', async () => {
    const { principal, dashboard, maya, leo, jamie } = await fixture();
    const expense = dashboard.expenses.find((entry) => entry.category === 'dinner')!;
    const leoRequest = dashboard.requests.find(
      (request) => request.expenseId === expense.id && request.to.id === leo.id,
    )!;
    const privateReason = 'Private conversation about my payment.';
    await db
      .updateTable('payment_requests')
      .set({ status: 'issue', issue_reason: privateReason })
      .where('id', '=', leoRequest.id)
      .execute();
    const mayaPrincipal = await sibling(principal, maya.id);
    const mayaDetail = await getExpenseDetail(mayaPrincipal, expense.id, db);
    expect(mayaDetail.expense.participants).toHaveLength(3);
    expect(
      mayaDetail.expense.participants.find((share) => share.person.id === leo.id)?.status,
    ).toBe('issue');
    expect(mayaDetail.requests).toHaveLength(1);
    expect(mayaDetail.requests[0]?.to.id).toBe(maya.id);
    expect(mayaDetail.requests[0]?.allowedActions).toContain('review_payment');
    expect(JSON.stringify(mayaDetail)).not.toContain(privateReason);
    const requesterDetail = await getExpenseDetail(principal, expense.id, db);
    expect(requesterDetail.requests).toHaveLength(2);
    expect(
      requesterDetail.requests.find((request) => request.id === leoRequest.id)?.issueReason,
    ).toBe(privateReason);
    await expect(
      getExpenseDetail(await sibling(principal, jamie.id), expense.id, db),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherVisitor = await fixture();
    await expect(getExpenseDetail(otherVisitor.principal, expense.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('publishes concurrent retried expenses once and rejects a changed payload', async () => {
    const { principal, maya, leo } = await fixture();
    const input: CreateExpenseInput = {
      title: 'Three coffees',
      emoji: '☕',
      category: 'coffee',
      totalMinor: '1000',
      method: 'equal',
      participantIds: [principal.personId, maya.id, leo.id],
    };
    const key = randomUUID();
    const expenses = await Promise.all(
      Array.from({ length: 8 }, () => createExpense(principal, input, key, db)),
    );
    expect(new Set(expenses.map((expense) => expense.id)).size).toBe(1);
    expect(expenses[0]?.participants.map((share) => share.amountMinor).sort()).toEqual([
      '333',
      '333',
      '334',
    ]);
    expect(
      await db
        .selectFrom('payment_requests')
        .select('id')
        .where('expense_id', '=', expenses[0]!.id)
        .execute(),
    ).toHaveLength(2);
    await expect(
      createExpense(principal, { ...input, totalMinor: '1001' }, key, db),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('validates custom shares, preserves zero shares, and does not create self requests', async () => {
    const { principal, maya, leo } = await fixture();
    const input: CreateExpenseInput = {
      title: 'A small treat',
      emoji: '🍪',
      category: 'other',
      totalMinor: '1000',
      method: 'custom',
      participantIds: [principal.personId, maya.id, leo.id],
      shares: [
        { participantId: principal.personId, amountMinor: '500' },
        { participantId: maya.id, amountMinor: '500' },
        { participantId: leo.id, amountMinor: '0' },
      ],
    };
    const expense = await createExpense(principal, input, randomUUID(), db);
    expect(expense.participants.find((share) => share.person.id === leo.id)).toMatchObject({
      amountMinor: '0',
      status: 'no_payment',
      requestId: null,
    });
    const requests = await db
      .selectFrom('payment_requests')
      .selectAll()
      .where('expense_id', '=', expense.id)
      .execute();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.debtor_id).toBe(maya.id);
    await expect(
      createExpense(principal, { ...input, shares: input.shares!.slice(0, 2) }, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'INVALID_SHARES' });
  });

  it('requires resolved item arithmetic and explicit tax and tip for item splits', async () => {
    const { principal, maya } = await fixture();
    const input: CreateExpenseInput = {
      title: 'Lunch',
      emoji: '🥗',
      category: 'dinner',
      totalMinor: '2600',
      method: 'items',
      participantIds: [principal.personId, maya.id],
      items: [
        {
          id: 'food',
          name: 'Lunch for two',
          amountMinor: '2000',
          participantIds: [principal.personId, maya.id],
        },
      ],
      taxMinor: '200',
      tipMinor: '400',
    };
    const expense = await createExpense(principal, input, randomUUID(), db);
    expect(expense.participants.map((share) => share.amountMinor)).toEqual(['1300', '1300']);
    await expect(
      createExpense(principal, { ...input, totalMinor: '2601' }, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'TOTAL_MISMATCH' });
    await expect(
      createExpense(principal, { ...input, taxMinor: undefined }, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'TOTAL_MISMATCH' });
  });

  it('does not grant a payee authority to approve a payer request', async () => {
    const { principal, dashboard } = await fixture();
    const outgoing = dashboard.requests.find(
      (request) => request.from.id === principal.personId && request.status === 'open',
    );
    await expect(reviewRequest(principal, outgoing!.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('authorizes ten retries as one consent and one durable operation', async () => {
    const { principal, dashboard } = await fixture();
    const request = dashboard.requests.find(
      (entry) => entry.to.id === principal.personId && entry.status === 'open',
    )!;
    const review = await reviewRequest(principal, request.id, db);
    const key = randomUUID();
    const operations = await Promise.all(
      Array.from({ length: 10 }, () =>
        authorizeReview(principal, review.id, review.reviewDigest, key, db),
      ),
    );
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
    expect(operations[0]?.status).toBe('queued');
    expect(
      await db
        .selectFrom('payment_consents')
        .select('id')
        .where('review_id', '=', review.id)
        .execute(),
    ).toHaveLength(1);
    await expect(
      authorizeReview(principal, review.id, review.reviewDigest, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'REVIEW_ALREADY_USED' });
    await expect(
      authorizeReview(principal, review.id, 'a'.repeat(64), key, db),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('allows exactly one fresh review to reserve a request under contention', async () => {
    const { principal, dashboard } = await fixture();
    const request = dashboard.requests.find(
      (entry) => entry.to.id === principal.personId && entry.status === 'open',
    )!;
    const reviews = await Promise.all(
      Array.from({ length: 5 }, () => reviewRequest(principal, request.id, db)),
    );
    const results = await Promise.allSettled(
      reviews.map((review) =>
        authorizeReview(principal, review.id, review.reviewDigest, randomUUID(), db),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
    expect(
      await db.selectFrom('operations').select('id').where('request_id', '=', request.id).execute(),
    ).toHaveLength(1);
  });

  it('rejects changed review digests without creating consent', async () => {
    const { principal, maya } = await fixture();
    const review = await reviewSend(
      principal,
      { recipientId: maya.id, amountMinor: '1700', note: 'Thanks for the ride' },
      db,
    );
    await expect(
      authorizeReview(principal, review.id, 'a'.repeat(64), randomUUID(), db),
    ).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(
      await db
        .selectFrom('payment_consents')
        .select('id')
        .where('review_id', '=', review.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('prevents a separate direct send from accidentally duplicating an existing request', async () => {
    const { principal, dashboard } = await fixture();
    const request = dashboard.requests.find(
      (entry) => entry.to.id === principal.personId && entry.status === 'open',
    )!;
    await expect(
      reviewSend(
        principal,
        { recipientId: request.from.id, amountMinor: request.amountMinor, note: 'Paying you back' },
        db,
      ),
    ).rejects.toMatchObject({ code: 'EXISTING_REQUEST' });
    await expect(
      reviewSend(
        principal,
        { recipientId: principal.personId, amountMinor: '100', note: 'Me' },
        db,
      ),
    ).rejects.toMatchObject({ code: 'SELF_PAYMENT' });
  });

  it('retains a queued operation after worker transaction rollback and safely recovers', async () => {
    const { principal, operation, request } = await queuedPayment();
    await expect(
      db.transaction().execute(async (tx) => {
        await completeSimulatedOperation(tx, operation.id);
        throw new Error('Simulated crash before commit');
      }),
    ).rejects.toThrow('Simulated crash before commit');
    expect((await getOperation(principal, operation.id, db)).status).toBe('queued');
    expect(
      await db
        .selectFrom('settlement_events')
        .select('id')
        .where('operation_id', '=', operation.id)
        .execute(),
    ).toHaveLength(0);
    await Promise.all(Array.from({ length: 5 }, () => processDueSimulatedOperations(db)));
    expect((await getOperation(principal, operation.id, db)).status).toBe('completed');
    expect(
      await db
        .selectFrom('settlement_events')
        .select('id')
        .where('operation_id', '=', operation.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await db
          .selectFrom('payment_requests')
          .select('status')
          .where('id', '=', request.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('paid');
    await processDueSimulatedOperations(db);
    expect(
      await db
        .selectFrom('activity')
        .select('id')
        .where('operation_id', '=', operation.id)
        .execute(),
    ).toHaveLength(2);
  });

  it('isolates an operation from another visitor and unrelated friends', async () => {
    const first = await queuedPayment();
    const second = await fixture();
    await expect(getOperation(second.principal, first.operation.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const unrelated = await sibling(first.principal, first.leo.id);
    await expect(getOperation(unrelated, first.operation.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('serializes cancellation versus approval without marking a moving payment canceled', async () => {
    const { principal, dashboard } = await fixture();
    const request = dashboard.requests.find(
      (entry) => entry.to.id === principal.personId && entry.status === 'open',
    )!;
    const payee = await sibling(principal, request.from.id);
    const review = await reviewRequest(principal, request.id, db);
    const results = await Promise.allSettled([
      authorizeReview(principal, review.id, review.reviewDigest, randomUUID(), db),
      changeRequest(payee, request.id, { expectedVersion: request.version, action: 'cancel' }, db),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = await db
      .selectFrom('payment_requests')
      .selectAll()
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    const operations = await db
      .selectFrom('operations')
      .select('id')
      .where('request_id', '=', request.id)
      .execute();
    expect(operations.length).toBe(current.status === 'processing' ? 1 : 0);
    expect(['processing', 'canceled']).toContain(current.status);
  });

  it('pauses a questioned request, invalidates its review, and allows the requester to cancel', async () => {
    const { principal, dashboard } = await fixture();
    const request = dashboard.requests.find(
      (entry) => entry.to.id === principal.personId && entry.status === 'open',
    )!;
    const review = await reviewRequest(principal, request.id, db);
    await changeRequest(
      principal,
      request.id,
      { expectedVersion: request.version, action: 'issue', reason: 'I did not have the wine.' },
      db,
    );
    await expect(
      authorizeReview(principal, review.id, review.reviewDigest, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const payee = await sibling(principal, request.from.id);
    await changeRequest(
      payee,
      request.id,
      { expectedVersion: request.version + 1, action: 'cancel' },
      db,
    );
    expect(
      (
        await db
          .selectFrom('payment_requests')
          .select('status')
          .where('id', '=', request.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('canceled');
  });

  it('rotates persona sessions and invalidates cached old authority and old reviews', async () => {
    const { principal, token, maya } = await fixture();
    const review = await reviewSend(
      principal,
      { recipientId: maya.id, amountMinor: '1234', note: 'A thank you' },
      db,
    );
    const newToken = await switchDemoPersona(principal, maya.id, db);
    await expect(resolveSession(token, db)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(
      authorizeReview(principal, review.id, review.reviewDigest, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const mayaPrincipal = await resolveSession(newToken, db);
    const backToken = await switchDemoPersona(mayaPrincipal, principal.personId, db);
    const back = await resolveSession(backToken, db);
    await expect(
      authorizeReview(back, review.id, review.reviewDigest, randomUUID(), db),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces immutable financial tuples and published participant membership in PostgreSQL', async () => {
    const { principal, dashboard, jamie } = await fixture();
    const expense = dashboard.expenses.find((entry) => entry.category === 'dinner')!;
    await expect(
      db.updateTable('expenses').set({ total_minor: '1' }).where('id', '=', expense.id).execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db
        .insertInto('expense_allocations')
        .values({
          workspace_id: principal.workspaceId,
          expense_id: expense.id,
          person_id: jamie.id,
          amount_minor: '0',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    const request = dashboard.requests.find((entry) => entry.expenseId === expense.id)!;
    await expect(
      db
        .updateTable('payment_requests')
        .set({ amount_minor: '1' })
        .where('id', '=', request.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects unbalanced publication and mismatched settlement amounts at the database boundary', async () => {
    const { principal, operation } = await queuedPayment();
    await expect(
      db
        .insertInto('settlement_events')
        .values({
          id: randomUUID(),
          workspace_id: principal.workspaceId,
          operation_id: operation.id,
          amount_minor: '1',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db
        .insertInto('expenses')
        .values({
          id: randomUUID(),
          workspace_id: principal.workspaceId,
          paid_by_id: principal.personId,
          title: 'Incomplete fixture',
          emoji: '☕',
          category: 'coffee',
          total_minor: '1000',
          method: 'equal',
          items: '[]',
          subtotal_minor: '1000',
          receipt_kind: 'manual',
          published_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
