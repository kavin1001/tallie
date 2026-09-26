import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@tallie/db';
import { ReceiptError } from './errors';
import { normalizeReceiptImage } from './media';
import { extractReceipt, RECEIPT_PROMPT_VERSION, type ExtractionResult } from './provider';
import {
  deleteReceiptFiles,
  readReceiptImage,
  removeStaleReceiptFile,
  staleReceiptFiles,
  storageDirectory,
  storeNormalized,
} from './storage';

const LEASE_MS = 120_000;
export async function claimReceiptJob(db: Kysely<Database>, now = new Date()) {
  return db.transaction().execute(async (tx) => {
    await tx
      .updateTable('receipt_captures')
      .set({
        status: 'failed',
        error_code: 'PROCESSING_INTERRUPTED',
        lease_token: null,
        lease_until: null,
        updated_at: now,
      })
      .where('status', '=', 'processing')
      .where('lease_until', '<=', now)
      .where('attempts', '>=', 2)
      .execute();
    const row = await tx
      .selectFrom('receipt_captures')
      .selectAll()
      .where('expires_at', '>', now)
      .where('available_at', '<=', now)
      .where('attempts', '<', 2)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'queued'),
          eb.and([eb('status', '=', 'processing'), eb('lease_until', '<=', now)]),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!row) return null;
    const lease = randomUUID();
    await tx
      .updateTable('receipt_captures')
      .set({
        status: 'processing',
        attempts: row.attempts + 1,
        lease_token: lease,
        lease_until: new Date(now.getTime() + LEASE_MS),
        error_code: null,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .execute();
    return { ...row, attempts: row.attempts + 1, lease_token: lease };
  });
}

export async function reserveProviderAttempt(
  db: Kysely<Database>,
  now = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const result = await sql<{ provider_attempts: number }>`
    INSERT INTO receipt_daily_budget(day, provider_attempts) VALUES (${day}, 1)
    ON CONFLICT (day) DO UPDATE SET provider_attempts = receipt_daily_budget.provider_attempts + 1
    WHERE receipt_daily_budget.provider_attempts < 80 RETURNING provider_attempts
  `.execute(db);
  if (!result.rows.length)
    throw new ReceiptError(
      'RECEIPT_BUDGET_REACHED',
      'Receipt reading has reached today’s limit. You can still enter the expense manually.',
    );
}

export async function finishReceiptJob(
  db: Kysely<Database>,
  id: string,
  lease: string,
  result: ExtractionResult,
  normalizedHash: string,
): Promise<boolean> {
  const updated = await db
    .updateTable('receipt_captures')
    .set({
      status: 'review_needed',
      proposal: JSON.stringify(result.proposal),
      normalized_hash: normalizedHash,
      model: result.model,
      prompt_version: RECEIPT_PROMPT_VERSION,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      lease_token: null,
      lease_until: null,
      error_code: null,
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .where('status', '=', 'processing')
    .where('lease_token', '=', lease)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  return updated.numUpdatedRows === 1n;
}

export async function processOneReceipt(
  db: Kysely<Database>,
  options: { directory?: string; extract?: (jpeg: Buffer) => Promise<ExtractionResult> } = {},
): Promise<boolean> {
  const job = await claimReceiptJob(db);
  if (!job) return false;
  const directory = options.directory ?? storageDirectory();
  try {
    const original = await readReceiptImage(job.id, 'original', directory);
    if (createHash('sha256').update(original).digest('hex') !== job.input_hash)
      throw new ReceiptError(
        'IMAGE_CHANGED',
        'This photo changed during processing. Upload it again.',
      );
    const jpeg = await normalizeReceiptImage(original);
    await storeNormalized(job.id, jpeg, directory);
    await reserveProviderAttempt(db);
    const result = await (options.extract ?? extractReceipt)(jpeg);
    await finishReceiptJob(
      db,
      job.id,
      job.lease_token,
      result,
      createHash('sha256').update(jpeg).digest('hex'),
    );
  } catch (error) {
    const expected = error instanceof ReceiptError;
    const retry = expected && error.retryable && job.attempts < 2;
    await db
      .updateTable('receipt_captures')
      .set({
        status: retry ? 'queued' : 'failed',
        error_code: expected ? error.code : 'PROCESSING_INTERRUPTED',
        lease_token: null,
        lease_until: null,
        available_at: new Date(Date.now() + 2_000),
        updated_at: new Date(),
      })
      .where('id', '=', job.id)
      .where('status', '=', 'processing')
      .where('lease_token', '=', job.lease_token)
      .execute();
  } finally {
    // A job may cross its expiry while an external request is in flight. Do not
    // recreate expired files after the periodic purge has already run.
    if (job.expires_at <= new Date()) await deleteReceiptFiles(job.id, directory);
  }
  return true;
}

export async function purgeExpiredReceipts(
  db: Kysely<Database>,
  directory = storageDirectory(),
): Promise<number> {
  const expired = await db
    .selectFrom('receipt_captures')
    .select('id')
    .where('expires_at', '<=', new Date())
    .where('purged_at', 'is', null)
    .limit(50)
    .execute();
  for (const row of expired) {
    await deleteReceiptFiles(row.id, directory);
    await db
      .updateTable('receipt_captures')
      .set({
        status: 'failed',
        proposal: null,
        normalized_hash: null,
        lease_token: null,
        lease_until: null,
        error_code: 'RECEIPT_EXPIRED',
        purged_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
  }
  for (const file of await staleReceiptFiles(directory)) {
    const retained = await db
      .selectFrom('receipt_captures')
      .select('id')
      .where('id', '=', file.id)
      .where('expires_at', '>', new Date())
      .where('purged_at', 'is', null)
      .executeTakeFirst();
    if (!retained) await removeStaleReceiptFile(file.path);
  }
  return expired.length;
}
