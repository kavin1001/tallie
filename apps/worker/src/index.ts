import {
  createDatabase,
  expirePhoneVerificationChallenges,
  processDueSimulatedOperations,
} from '@tallie/db';
import { cleanupExpiredIdentityProofs, type IdentityDatabase } from '@tallie/identity';
import type { Kysely } from 'kysely';

if (!['demo', 'beta'].includes(process.env.APP_MODE ?? '') || !process.env.DATABASE_URL)
  throw new Error('Configure DATABASE_URL and APP_MODE=demo or beta.');

const db = createDatabase(process.env.DATABASE_URL);
let stopping = false;
let failures = 0;
let lastPhoneCleanup = 0;
const stop = () => {
  stopping = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdout.write('Tallie maintenance ready. No real money moves.\n');

while (!stopping) {
  try {
    const completed = process.env.APP_MODE === 'demo' ? await processDueSimulatedOperations(db) : 0;
    if (Date.now() - lastPhoneCleanup >= 60_000) {
      await expirePhoneVerificationChallenges(db);
      await cleanupExpiredIdentityProofs(db as unknown as Kysely<IdentityDatabase>);
      lastPhoneCleanup = Date.now();
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
      `Maintenance database work failed (attempt ${failures}); durable operations retained.\n`,
    );
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(500 * 2 ** Math.min(failures, 4), 8_000)),
  );
}

await db.destroy();
