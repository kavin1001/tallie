import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { allocateByItem, allocateEqual } from '@tallie/domain';
import type { Kysely } from 'kysely';
import { insertPublishedExpense } from './expense';
import { completeSimulatedOperation } from './simulator';
import type { Database } from './schema';
import type { ExpenseItem } from './contracts';

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Every visitor gets different IDs and a private dataset. No shared demo writes. */
export async function createDemoWorkspace(
  db: Kysely<Database>,
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  await db.transaction().execute(async (tx) => {
    const workspaceId = randomUUID();
    await tx.insertInto('demo_workspaces').values({ id: workspaceId }).execute();
    const names = [
      { name: 'Alex Rivera', initials: 'AR', color: 'sage' },
      { name: 'Maya Chen', initials: 'MC', color: 'peach' },
      { name: 'Leo Park', initials: 'LP', color: 'lavender' },
      { name: 'Zoe Williams', initials: 'ZW', color: 'sky' },
      { name: 'Jamie Taylor', initials: 'JT', color: 'butter' },
    ].map((person) => ({
      ...person,
      id: randomUUID(),
      workspace_id: workspaceId,
      venmo_handle: null,
    }));
    await tx.insertInto('people').values(names).execute();
    const [alex, maya, leo, zoe, jamie] = names;
    if (!alex || !maya || !leo || !zoe || !jamie) throw new Error('Incomplete demo fixture.');
    await tx
      .insertInto('demo_sessions')
      .values({
        id: sessionId,
        token_hash: tokenHash(token),
        workspace_id: workspaceId,
        person_id: alex.id,
        expires_at: new Date(Date.now() + SESSION_LIFETIME_MS),
        revoked_at: null,
      })
      .execute();

    const dinnerPeople = [alex.id, maya.id, leo.id];
    const dinnerItems: ExpenseItem[] = [
      {
        id: 'shared-plates',
        name: 'A few things for the table',
        amountMinor: '6000',
        participantIds: dinnerPeople,
      },
      {
        id: 'house-wine',
        name: 'Two glasses of house red',
        amountMinor: '3000',
        participantIds: [alex.id, leo.id],
      },
    ];
    const dinner = allocateByItem({
      participantIds: dinnerPeople,
      items: dinnerItems.map((item) => ({
        id: item.id,
        totalMinor: BigInt(item.amountMinor),
        participantIds: item.participantIds,
      })),
      taxMinor: 900n,
      tipMinor: 1800n,
      statedTotalMinor: 11700n,
    });
    await insertPublishedExpense(tx, {
      workspaceId,
      paidById: alex.id,
      title: 'Friday at Lilia',
      emoji: '🍝',
      category: 'dinner',
      totalMinor: 11700n,
      method: 'items',
      allocations: dinner.allocations,
      items: dinnerItems,
      subtotalMinor: 9000n,
      taxMinor: 900n,
      tipMinor: 1800n,
      discountMinor: 0n,
      receiptKind: 'demo',
      createdAt: new Date(Date.now() - 60 * 60 * 1_000),
    });
    const fixtures = [
      {
        title: 'A little weekend away',
        emoji: '🌲',
        category: 'travel' as const,
        paidById: alex.id,
        total: 48000n,
        ids: [alex.id, maya.id, leo.id, zoe.id],
        hours: 22,
        settled: false,
      },
      {
        title: 'Coffee & catching up',
        emoji: '☕',
        category: 'coffee' as const,
        paidById: maya.id,
        total: 1850n,
        ids: [alex.id, maya.id],
        hours: 5,
        settled: false,
      },
      {
        title: 'Movie night essentials',
        emoji: '🍿',
        category: 'groceries' as const,
        paidById: jamie.id,
        total: 4860n,
        ids: [alex.id, jamie.id, zoe.id],
        hours: 28,
        settled: false,
      },
      {
        title: 'The best seats in the house',
        emoji: '🎟️',
        category: 'tickets' as const,
        paidById: alex.id,
        total: 7200n,
        ids: [alex.id, zoe.id],
        hours: 72,
        settled: true,
      },
    ];
    for (const fixture of fixtures) {
      const expenseId = await insertPublishedExpense(tx, {
        workspaceId,
        paidById: fixture.paidById,
        title: fixture.title,
        emoji: fixture.emoji,
        category: fixture.category,
        totalMinor: fixture.total,
        method: 'equal',
        allocations: allocateEqual(fixture.total, fixture.ids),
        items: [
          {
            id: randomUUID(),
            name: fixture.title,
            amountMinor: fixture.total.toString(),
            participantIds: fixture.ids,
          },
        ],
        subtotalMinor: fixture.total,
        taxMinor: 0n,
        tipMinor: 0n,
        discountMinor: 0n,
        receiptKind: 'demo',
        createdAt: new Date(Date.now() - fixture.hours * 60 * 60 * 1_000),
      });
      if (fixture.settled) {
        const requests = await tx
          .selectFrom('payment_requests')
          .selectAll()
          .where('expense_id', '=', expenseId)
          .execute();
        for (const request of requests) {
          const fixtureSessionId = randomUUID();
          await tx
            .insertInto('demo_sessions')
            .values({
              id: fixtureSessionId,
              token_hash: tokenHash(randomBytes(32).toString('hex')),
              workspace_id: workspaceId,
              person_id: request.debtor_id,
              expires_at: new Date(),
              revoked_at: new Date(),
            })
            .execute();
          const reviewId = randomUUID();
          const consentId = randomUUID();
          const operationId = randomUUID();
          const digest = tokenHash(`synthetic-fixture:${reviewId}`);
          await tx
            .insertInto('payment_reviews')
            .values({
              id: reviewId,
              workspace_id: workspaceId,
              session_id: fixtureSessionId,
              payer_id: request.debtor_id,
              payee_id: request.payee_id,
              request_id: request.id,
              request_version: 1,
              kind: 'request',
              amount_minor: request.amount_minor,
              note: fixture.title,
              digest,
              expires_at: new Date(),
            })
            .execute();
          await tx
            .insertInto('payment_consents')
            .values({
              id: consentId,
              workspace_id: workspaceId,
              review_id: reviewId,
              session_id: fixtureSessionId,
              actor_id: request.debtor_id,
              review_digest: digest,
            })
            .execute();
          await tx
            .updateTable('payment_requests')
            .set({ status: 'processing', version: 2 })
            .where('id', '=', request.id)
            .execute();
          await tx
            .insertInto('operations')
            .values({
              id: operationId,
              workspace_id: workspaceId,
              review_id: reviewId,
              consent_id: consentId,
              payer_id: request.debtor_id,
              payee_id: request.payee_id,
              request_id: request.id,
              kind: 'request',
              amount_minor: request.amount_minor,
              note: fixture.title,
              ready_at: new Date(),
              completed_at: null,
            })
            .execute();
          await completeSimulatedOperation(tx, operationId);
        }
      }
    }
  });
  return { token, sessionId };
}
