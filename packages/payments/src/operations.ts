import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';

export type PaymentEnvironment = 'sandbox' | 'production';

/** Call inside the same transaction that reserves a provider submission. */
export async function paymentSubmissionsAllowed(
  db: Kysely<PaymentDatabase>,
  environment: PaymentEnvironment,
): Promise<boolean> {
  const result = await sql<{ submissions_paused: boolean }>`
    SELECT submissions_paused FROM payment_runtime_controls
    WHERE environment=${environment} FOR SHARE
  `.execute(db);
  return result.rows[0]?.submissions_paused === false;
}

/** Operator-only. This release cannot resume production execution. */
export async function setPaymentSubmissionsPaused(
  db: Kysely<PaymentDatabase>,
  environment: PaymentEnvironment,
  paused: boolean,
): Promise<void> {
  if (environment === 'production' && !paused)
    throw new Error('Production submission is not implemented in this release.');
  await db.transaction().execute(async (tx) => {
    const changed = await sql`
      UPDATE payment_runtime_controls SET submissions_paused=${paused},changed_at=now()
      WHERE environment=${environment} AND submissions_paused IS DISTINCT FROM ${paused}
      RETURNING environment
    `.execute(tx);
    if (changed.rows.length)
      await sql`
        INSERT INTO payment_runtime_control_history(environment,submissions_paused)
        VALUES (${environment},${paused})
      `.execute(tx);
  });
}

/** Contains operational timestamps only; no customer or provider payloads. */
export async function recordPaymentWorkerHeartbeat(
  db: Kysely<PaymentDatabase>,
  environment: PaymentEnvironment,
  instanceId: string,
  succeeded: boolean,
  now = new Date(),
): Promise<void> {
  await sql`
    INSERT INTO payment_worker_heartbeats
      (environment,instance_id,seen_at,succeeded_at,failures)
    VALUES (${environment},${instanceId}::uuid,${now},${succeeded ? now : null},${succeeded ? 0 : 1})
    ON CONFLICT(environment,instance_id) DO UPDATE SET
      seen_at=EXCLUDED.seen_at,
      succeeded_at=COALESCE(EXCLUDED.succeeded_at,payment_worker_heartbeats.succeeded_at),
      failures=CASE WHEN ${succeeded} THEN 0 ELSE payment_worker_heartbeats.failures+1 END
  `.execute(db);
  await sql`
    DELETE FROM payment_worker_heartbeats WHERE seen_at < ${new Date(now.getTime() - 7 * 86400_000)}
  `.execute(db);
}

export async function paymentWorkerHealth(
  db: Kysely<PaymentDatabase>,
  environment: PaymentEnvironment,
  now = new Date(),
) {
  const result = await sql<{ healthy: boolean; submissions_paused: boolean }>`
    SELECT c.submissions_paused,
      EXISTS(SELECT 1 FROM payment_worker_heartbeats h
        WHERE h.environment=c.environment AND h.failures=0
          AND h.succeeded_at > ${new Date(now.getTime() - 120_000)}
          AND h.succeeded_at <= ${now}) AS healthy
    FROM payment_runtime_controls c WHERE c.environment=${environment}
  `.execute(db);
  return {
    environment,
    workerHealthy: result.rows[0]?.healthy ?? false,
    submissionsPaused: result.rows[0]?.submissions_paused ?? true,
  };
}
