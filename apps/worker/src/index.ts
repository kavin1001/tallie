import {
  createDatabase,
  expirePhoneVerificationChallenges,
  processDueSimulatedOperations,
} from '@tallie/db';
import { cleanupExpiredIdentityProofs, type IdentityDatabase } from '@tallie/identity';
import { configuredPaymentReconciliation } from '@tallie/app-services/payments';
import { configuredProductionConnections } from '@tallie/app-services/production-payments';
import {
  NaturalWebhookInboxService,
  recordPaymentWorkerHeartbeat,
  type PaymentDatabase,
} from '@tallie/payments';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

if (!['demo', 'beta'].includes(process.env.APP_MODE ?? '') || !process.env.DATABASE_URL)
  throw new Error('Configure DATABASE_URL and APP_MODE=demo or beta.');

const db = createDatabase(process.env.DATABASE_URL);
const paymentsDb = db as unknown as Kysely<PaymentDatabase>;
const reconciler = configuredPaymentReconciliation(paymentsDb);
const productionConnections = configuredProductionConnections(paymentsDb);
const paymentInbox =
  reconciler && process.env.NATURAL_SANDBOX_WEBHOOK_ENABLED === 'true'
    ? new NaturalWebhookInboxService(paymentsDb, {
        environment: 'sandbox',
        agentId: process.env.NATURAL_AGENT_ID!,
        platformPartyId: process.env.NATURAL_PLATFORM_PARTY_ID!,
      })
    : null;
const productionInbox = productionConnections
  ? new NaturalWebhookInboxService(paymentsDb, {
      environment: 'production',
      agentId: process.env.NATURAL_PRODUCTION_AGENT_ID!,
      platformPartyId: process.env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID!,
    })
  : null;
const instanceId = randomUUID();
let stopping = false;
let failures = 0;
let lastPhoneCleanup = 0;
let lastHeartbeat = 0;
async function heartbeat(succeeded: boolean) {
  if (succeeded && Date.now() - lastHeartbeat < 15_000) return;
  if (reconciler) await recordPaymentWorkerHeartbeat(paymentsDb, 'sandbox', instanceId, succeeded);
  if (productionConnections)
    await recordPaymentWorkerHeartbeat(paymentsDb, 'production', instanceId, succeeded);
  lastHeartbeat = Date.now();
}
const stop = () => {
  stopping = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdout.write('Tallie maintenance ready. No real money moves.\n');
if (reconciler) process.stdout.write('Sandbox reconciliation enabled; canonical reads only.\n');
if (productionConnections)
  process.stdout.write('Production account connection checks enabled; no money movement.\n');

while (!stopping) {
  try {
    await heartbeat(true);
    const completed = process.env.APP_MODE === 'demo' ? await processDueSimulatedOperations(db) : 0;
    if (Date.now() - lastPhoneCleanup >= 60_000) {
      await expirePhoneVerificationChallenges(db);
      await cleanupExpiredIdentityProofs(db as unknown as Kysely<IdentityDatabase>);
      lastPhoneCleanup = Date.now();
      await paymentInbox?.purgeExpiredPayloads();
      await productionInbox?.purgeExpiredPayloads();
    }
    // Bounded batches leave room for identity maintenance and graceful shutdown.
    for (let batch = 0; paymentInbox && batch < 10 && !stopping; batch++)
      if (!(await paymentInbox.processOne((hint) => reconciler!.wake(hint)))) break;
    for (let batch = 0; reconciler && batch < 3 && !stopping; batch++) {
      if (!(await reconciler.processOne())) break;
      await heartbeat(true);
    }
    for (let batch = 0; productionInbox && batch < 3 && !stopping; batch++) {
      if (
        !(await productionInbox.processAcceptanceOne((hint) =>
          productionConnections!.reconcileAcceptedInvitation(hint),
        ))
      )
        break;
      await heartbeat(true);
    }
    failures = 0;
    if (completed > 0)
      process.stdout.write(
        `Completed ${completed} simulated operation${completed === 1 ? '' : 's'}.\n`,
      );
  } catch {
    failures += 1;
    // No request bodies, tokens, names, or provider details enter worker logs.
    process.stderr.write(
      `Maintenance work failed (attempt ${failures}); durable operations retained.\n`,
    );
    await heartbeat(false).catch(() => {});
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(500 * 2 ** Math.min(failures, 4), 8_000)),
  );
}

await db.destroy();
