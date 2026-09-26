import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { database, type Database } from '@tallie/db';
import {
  decodeReceiptUpload,
  ReceiptError,
  type ReceiptDraft,
  type ReceiptUpload,
} from '@tallie/receipts';
import {
  deleteReceiptFiles,
  readReceiptImage,
  storageDirectory,
  storeOriginal,
} from '@tallie/receipts/storage';
import { AppError } from '../errors';
import { lockSession, type Principal } from '../session';

import { toReceiptDraft } from '@tallie/receipts/draft';
export { toReceiptDraft } from '@tallie/receipts/draft';

export async function createReceiptDraft(
  principal: Principal,
  input: ReceiptUpload,
  retryKey: string,
  options: { db?: Kysely<Database>; directory?: string } = {},
): Promise<ReceiptDraft> {
  const db = options.db ?? database();
  const directory = options.directory ?? storageDirectory();
  const bytes = decodeReceiptUpload(input.contentBase64, input.contentType);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let storedId: string | null = null;
  try {
    return await db.transaction().execute(async (tx) => {
      await lockSession(tx, principal);
      // A global transaction lock serializes quota reservation and retry publication.
      await sql`SELECT pg_advisory_xact_lock(726512034)`.execute(tx);
      const existing = await tx
        .selectFrom('receipt_captures')
        .selectAll()
        .where('workspace_id', '=', principal.workspaceId)
        .where('person_id', '=', principal.personId)
        .where('session_id', '=', principal.sessionId)
        .where('retry_key', '=', retryKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.input_hash !== hash || existing.content_type !== input.contentType)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This retry belongs to a different photo. Choose the photo again.',
            409,
          );
        if (existing.expires_at <= new Date())
          throw new AppError(
            'RECEIPT_EXPIRED',
            'This receipt draft has expired. Upload the photo again.',
            410,
          );
        return toReceiptDraft(existing);
      }
      const midnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const counts = await tx
        .selectFrom('receipt_captures')
        .select((eb) => [
          eb.fn.countAll<string>().as('globalCount'),
          eb.fn
            .countAll<string>()
            .filterWhere('workspace_id', '=', principal.workspaceId)
            .as('workspaceCount'),
        ])
        .where('created_at', '>=', midnight)
        .executeTakeFirstOrThrow();
      if (Number(counts.globalCount) >= 50 || Number(counts.workspaceCount) >= 10)
        throw new AppError(
          'RECEIPT_LIMIT_REACHED',
          'You’ve reached today’s receipt limit. You can still enter expenses manually.',
          429,
        );
      const id = randomUUID();
      await storeOriginal(id, bytes, directory);
      storedId = id;
      const row = await tx
        .insertInto('receipt_captures')
        .values({
          id,
          workspace_id: principal.workspaceId,
          person_id: principal.personId,
          session_id: principal.sessionId,
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
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          purged_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toReceiptDraft(row);
    });
  } catch (error) {
    if (storedId) {
      // A lost COMMIT reply is not proof of rollback. Keep committed input intact;
      // if PostgreSQL is unavailable, the private orphan sweep handles it later.
      const orphanId = storedId;
      await db
        .transaction()
        .execute(async (tx) => {
          await sql`SELECT pg_advisory_xact_lock(726512034)`.execute(tx);
          const committed = await tx
            .selectFrom('receipt_captures')
            .select('id')
            .where('id', '=', orphanId)
            .executeTakeFirst();
          if (!committed) await deleteReceiptFiles(orphanId, directory);
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function getReceiptDraft(
  principal: Principal,
  id: string,
  db = database(),
): Promise<ReceiptDraft> {
  const row = await db.transaction().execute(async (tx) => {
    await lockSession(tx, principal);
    return tx
      .selectFrom('receipt_captures')
      .selectAll()
      .where('id', '=', id)
      .where('workspace_id', '=', principal.workspaceId)
      .where('person_id', '=', principal.personId)
      .where('session_id', '=', principal.sessionId)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
  });
  if (!row) throw new AppError('NOT_FOUND', 'This receipt draft is unavailable.', 404);
  return toReceiptDraft(row);
}

export async function getReceiptImage(
  principal: Principal,
  id: string,
  options: { db?: Kysely<Database>; directory?: string } = {},
): Promise<Buffer> {
  const draft = await getReceiptDraft(principal, id, options.db ?? database());
  if (!draft.imageUrl) throw new AppError('NOT_FOUND', 'The receipt preview is not ready.', 404);
  try {
    return await readReceiptImage(id, 'normalized', options.directory ?? storageDirectory());
  } catch {
    throw new ReceiptError('IMAGE_UNAVAILABLE', 'The receipt preview is unavailable.');
  }
}
