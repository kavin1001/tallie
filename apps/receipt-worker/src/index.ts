import { createDatabase } from '@tallie/db';
import { processOneReceipt, purgeExpiredReceipts } from '@tallie/receipts/jobs';

let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});

if (process.env.RECEIPTS_ENABLED !== 'true') {
  console.info('Receipt worker disabled.');
} else if (
  !process.env.OPENAI_API_KEY ||
  !process.env.DATABASE_URL ||
  (process.env.RECEIPT_STORAGE_DRIVER === 's3'
    ? !process.env.RECEIPTS_BUCKET || !process.env.AWS_REGION
    : !process.env.RECEIPT_STORAGE_DIR)
) {
  console.error('Receipt worker configuration is incomplete.');
  process.exitCode = 1;
} else {
  const db = createDatabase(process.env.DATABASE_URL);
  let lastPurge = 0;
  console.info('Receipt worker ready.');
  while (!stopped) {
    try {
      if (Date.now() - lastPurge > 60_000) {
        await purgeExpiredReceipts(db);
        lastPurge = Date.now();
      }
      const worked = await processOneReceipt(db);
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 750));
    } catch (error) {
      // Never log provider bodies, receipt contents, storage paths, or credentials.
      console.error(
        JSON.stringify({
          event: 'receipt_worker_interrupted',
          errorType: error instanceof Error ? error.name : 'Unknown',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  await db.destroy();
}
