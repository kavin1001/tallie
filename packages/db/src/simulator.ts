import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema';

/**
 * A local simulator has no network side effect. We can atomically complete its
 * operation, unique settlement, request state, and feed in one DB transaction.
 * A real provider adapter must implement dispatch/reconciliation separately.
 */
export async function completeSimulatedOperation(
  tx: Transaction<Database>,
  operationId: string,
): Promise<boolean> {
  const operation = await tx
    .selectFrom('operations')
    .selectAll()
    .where('id', '=', operationId)
    .forUpdate()
    .executeTakeFirst();
  if (!operation || operation.status === 'completed' || operation.status === 'failed') return false;
  if (operation.provider !== 'simulator')
    throw new Error('Simulator cannot execute a live provider operation.');
  let expenseId: string | null = null;
  if (operation.request_id) {
    const request = await tx
      .selectFrom('payment_requests')
      .selectAll()
      .where('id', '=', operation.request_id)
      .where('workspace_id', '=', operation.workspace_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (request.status !== 'processing')
      throw new Error('Simulator request lost its reserved collection state.');
    expenseId = request.expense_id;
    await tx
      .updateTable('payment_requests')
      .set({ status: 'paid', version: sql`version + 1`, updated_at: new Date() })
      .where('id', '=', request.id)
      .execute();
  }
  const completedAt = new Date();
  await tx
    .insertInto('settlement_events')
    .values({
      id: randomUUID(),
      workspace_id: operation.workspace_id,
      operation_id: operation.id,
      amount_minor: operation.amount_minor,
      created_at: completedAt,
    })
    .execute();
  await tx
    .updateTable('operations')
    .set({ status: 'completed', completed_at: completedAt })
    .where('id', '=', operation.id)
    .execute();
  const people = await tx
    .selectFrom('people')
    .select(['id', 'name'])
    .where('workspace_id', '=', operation.workspace_id)
    .where('id', 'in', [operation.payer_id, operation.payee_id])
    .execute();
  const payer = people.find((person) => person.id === operation.payer_id);
  const payee = people.find((person) => person.id === operation.payee_id);
  if (!payer || !payee) throw new Error('Operation participants are missing.');
  await tx
    .insertInto('activity')
    .values([
      {
        id: randomUUID(),
        workspace_id: operation.workspace_id,
        user_id: operation.payer_id,
        person_id: operation.payee_id,
        expense_id: expenseId,
        operation_id: operation.id,
        type: 'payment_sent',
        title: `You paid ${payee.name.split(' ')[0]}`,
        description: operation.note,
        emoji: '↗',
        amount_minor: operation.amount_minor,
        created_at: completedAt,
      },
      {
        id: randomUUID(),
        workspace_id: operation.workspace_id,
        user_id: operation.payee_id,
        person_id: operation.payer_id,
        expense_id: expenseId,
        operation_id: operation.id,
        type: 'payment_received',
        title: `${payer.name.split(' ')[0]} paid you`,
        description: operation.note,
        emoji: '↙',
        amount_minor: operation.amount_minor,
        created_at: completedAt,
      },
    ])
    .execute();
  return true;
}

/** SKIP LOCKED allows several local workers without duplicating effects. */
export async function processDueSimulatedOperations(
  db: Kysely<Database>,
  batchSize = 20,
): Promise<number> {
  if (process.env.APP_MODE !== 'demo')
    throw new Error('Simulation is disabled outside APP_MODE=demo.');
  let completed = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const result = await db.transaction().execute(async (tx) => {
      const operation = await tx
        .selectFrom('operations')
        .select('id')
        .where('status', 'in', ['queued', 'processing'])
        .where('ready_at', '<=', new Date())
        .orderBy('ready_at')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!operation) return false;
      return completeSimulatedOperation(tx, operation.id);
    });
    if (!result) break;
    completed += 1;
  }
  return completed;
}
