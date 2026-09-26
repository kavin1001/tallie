import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { createDatabase, type Database } from '@tallie/db';
import { decodeReceiptUpload, type ReceiptDraft, type ReceiptUpload } from './index';
import { deleteReceiptFiles, readReceiptImage, storageDirectory, storeOriginal } from './storage';
import { ReceiptError } from './errors';
import { toReceiptDraft } from './draft';

let connection: Kysely<Database> | undefined;
export function accountReceiptDatabase() {
  if (!process.env.DATABASE_URL)
    throw new ReceiptError('UNAVAILABLE', 'Receipt storage is unavailable.', false, 503);
  return (connection ??= createDatabase(process.env.DATABASE_URL));
}

function accountDraft(draft: ReceiptDraft): ReceiptDraft {
  return { ...draft, imageUrl: draft.imageUrl ? `/api/account-receipts/${draft.id}/image` : null };
}

/** Caller must hold either the established session or current channel grant in this transaction. */
export async function createOwnedReceipt(
  userId: string,
  input: ReceiptUpload,
  retryKey: string,
  authorize: (tx: Transaction<Database>) => Promise<void>,
  options: { db?: Kysely<Database>; directory?: string } = {},
): Promise<ReceiptDraft> {
  const db = options.db ?? accountReceiptDatabase();
  const directory = options.directory ?? storageDirectory();
  const bytes = decodeReceiptUpload(input.contentBase64, input.contentType);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let storedId: string | null = null;
  try {
    return await db.transaction().execute(async (tx) => {
      await authorize(tx);
      await sql`SELECT pg_advisory_xact_lock(726512034)`.execute(tx);
      const existing = await tx
        .selectFrom('receipt_captures')
        .selectAll()
        .where('account_user_id', '=', userId)
        .where('retry_key', '=', retryKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash || existing.content_type !== input.contentType)
          throw new ReceiptError(
            'IDEMPOTENCY_CONFLICT',
            'This retry belongs to another photo.',
            false,
            409,
          );
        if (existing.expires_at <= new Date())
          throw new ReceiptError(
            'RECEIPT_EXPIRED',
            'Upload this photo again to start a fresh draft.',
            false,
            410,
          );
        return accountDraft(toReceiptDraft(existing));
      }
      const midnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const counts = await tx
        .selectFrom('receipt_captures')
        .select((eb) => [
          eb.fn.countAll<string>().as('globalCount'),
          eb.fn.countAll<string>().filterWhere('account_user_id', '=', userId).as('userCount'),
        ])
        .where('created_at', '>=', midnight)
        .executeTakeFirstOrThrow();
      if (Number(counts.globalCount) >= 50 || Number(counts.userCount) >= 10)
        throw new ReceiptError(
          'RECEIPT_LIMIT_REACHED',
          'Today’s receipt limit has been reached. You can still enter the details yourself.',
          false,
          429,
        );
      const id = randomUUID();
      await storeOriginal(id, bytes, directory);
      storedId = id;
      const row = await tx
        .insertInto('receipt_captures')
        .values({
          id,
          account_user_id: userId,
          workspace_id: null,
          person_id: null,
          session_id: null,
          retry_key: retryKey,
          input_hash: hash,
          input_bytes: bytes.length,
          content_type: input.contentType,
          error_code: null,
          normalized_hash: null,
          lease_token: null,
          lease_until: null,
          model: null,
          prompt_version: null,
          input_tokens: null,
          output_tokens: null,
          expires_at: new Date(Date.now() + 86_400_000),
          purged_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return accountDraft(toReceiptDraft(row));
    });
  } catch (error) {
    if (storedId) {
      const id = storedId;
      await db
        .transaction()
        .execute(async (tx) => {
          await sql`SELECT pg_advisory_xact_lock(726512034)`.execute(tx);
          const committed = await tx
            .selectFrom('receipt_captures')
            .select('id')
            .where('id', '=', id)
            .executeTakeFirst();
          if (!committed) await deleteReceiptFiles(id, directory);
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function readOwnedReceipt(
  userId: string,
  id: string,
  db = accountReceiptDatabase(),
): Promise<ReceiptDraft> {
  const row = await db
    .selectFrom('receipt_captures')
    .selectAll()
    .where('id', '=', id)
    .where('account_user_id', '=', userId)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row) throw new ReceiptError('NOT_FOUND', 'This receipt draft is unavailable.', false, 404);
  return accountDraft(toReceiptDraft(row));
}
export async function readOwnedImage(
  userId: string,
  id: string,
  options: { db?: Kysely<Database>; directory?: string } = {},
) {
  const draft = await readOwnedReceipt(userId, id, options.db ?? accountReceiptDatabase());
  if (!draft.imageUrl)
    throw new ReceiptError('NOT_FOUND', 'The receipt preview is not ready.', false, 404);
  return readReceiptImage(id, 'normalized', options.directory ?? storageDirectory());
}
