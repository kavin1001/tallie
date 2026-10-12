import { createDatabase } from '@tallie/db';
import {
  paymentWorkerHealth,
  setPaymentSubmissionsPaused,
  type PaymentDatabase,
  type PaymentEnvironment,
} from '@tallie/payments';
import { sql, type Kysely } from 'kysely';

/** Private operator CLI: aggregate health only, never provider bodies or credentials. */
async function main() {
  const [command, selector, ...extra] = process.argv.slice(2);
  if (
    !command ||
    !['status', 'pause', 'resume'].includes(command) ||
    !selector ||
    !/^--environment=(sandbox|production)$/.test(selector) ||
    extra.length
  )
    throw new Error('Use status|pause|resume --environment=sandbox|production.');
  const environment = selector.slice('--environment='.length) as PaymentEnvironment;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = createDatabase(process.env.DATABASE_URL) as unknown as Kysely<PaymentDatabase>;
  try {
    if (command !== 'status')
      await setPaymentSubmissionsPaused(db, environment, command === 'pause');
    const health = await paymentWorkerHealth(db, environment);
    const jobs =
      environment === 'sandbox'
        ? (
            await sql<{ ready: number; attention: number; overdue: number }>`
        SELECT count(*) FILTER(WHERE status='ready')::int AS ready,
          count(*) FILTER(WHERE attention_reason IS NOT NULL AND attention_reason<>'monitor_window_closed')::int AS attention,
          count(*) FILTER(WHERE status='ready' AND available_at<now()-interval '2 minutes'
            AND (lease_until IS NULL OR lease_until<now()))::int AS overdue
        FROM natural_sandbox_reconciliation_jobs
      `.execute(db)
          ).rows[0]
        : null;
    const inbox = (
      await sql<{ pending: number; quarantined: number }>`
      SELECT count(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending,
        count(*) FILTER(WHERE status='quarantined')::int AS quarantined
      FROM natural_webhook_inbox WHERE environment=${environment}
    `.execute(db)
    ).rows[0];
    console.log(
      JSON.stringify(
        { ...health, reconciliation: jobs, webhooks: inbox, realMoneyEnabled: false },
        null,
        2,
      ),
    );
    if (
      command === 'status' &&
      (!health.workerHealthy ||
        (jobs?.attention ?? 0) > 0 ||
        (jobs?.overdue ?? 0) > 0 ||
        (inbox?.quarantined ?? 0) > 0)
    )
      process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

void main().catch(() => {
  console.error(
    JSON.stringify({
      status: 'unavailable',
      message:
        'Check the command, intended database and applied migrations. Production cannot be resumed by this release.',
    }),
  );
  process.exitCode = 1;
});
