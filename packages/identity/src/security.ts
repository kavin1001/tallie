import { sql, type Kysely, type Transaction } from 'kysely';
import type { AccountPrincipal } from './contracts';
import { identityDatabase, lockAccount, type IdentityDatabase } from './database';
import { IdentityError } from './errors';

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string | null;
}
export async function listAccountPasskeys(
  principal: AccountPrincipal,
  db: Kysely<IdentityDatabase> = identityDatabase(),
): Promise<PasskeySummary[]> {
  await lockAccount(db, principal);
  const keys = await db
    .selectFrom('auth_passkey')
    .select(['id', 'name', 'created_at'])
    .where('user_id', '=', principal.userId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return keys.map((key) => ({
    id: key.id,
    name: key.name?.trim() || 'My passkey',
    createdAt: key.created_at?.toISOString() ?? null,
  }));
}
async function securityLock(
  tx: Transaction<IdentityDatabase>,
  principal: AccountPrincipal,
  now: Date,
) {
  // All credential-management transactions lock the user before their session,
  // so revoking other sessions cannot deadlock concurrent credential removal.
  await tx
    .selectFrom('auth_user')
    .select('id')
    .where('id', '=', principal.userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await lockAccount(tx, principal);
  const session = await tx
    .selectFrom('auth_session')
    .select(['assurance_kind', 'assurance_at'])
    .where('id', '=', principal.sessionId)
    .executeTakeFirstOrThrow();
  if (
    session.assurance_kind !== 'passkey' ||
    !session.assurance_at ||
    now.getTime() - session.assurance_at.getTime() > 15 * 60_000
  )
    throw new IdentityError(
      'STEP_UP_REQUIRED',
      'Use a passkey before changing your saved passkeys.',
      403,
    );
}
export async function removeAccountPasskey(
  principal: AccountPrincipal,
  passkeyId: string,
  db: Kysely<IdentityDatabase> = identityDatabase(),
  now = new Date(),
): Promise<{ removed: true }> {
  return db.transaction().execute(async (tx) => {
    await securityLock(tx, principal, now);
    const keys = await tx
      .selectFrom('auth_passkey')
      .select('id')
      .where('user_id', '=', principal.userId)
      .forUpdate()
      .execute();
    if (!keys.some((key) => key.id === passkeyId))
      throw new IdentityError('NOT_FOUND', 'This passkey could not be found.', 404);
    if (keys.length <= 1)
      throw new IdentityError('LAST_PASSKEY', 'Add another passkey before removing this one.', 409);
    await tx
      .deleteFrom('auth_passkey')
      .where('id', '=', passkeyId)
      .where('user_id', '=', principal.userId)
      .execute();
    await tx
      .deleteFrom('auth_session')
      .where('user_id', '=', principal.userId)
      .where('id', '!=', principal.sessionId)
      .execute();
    return { removed: true };
  });
}

/** Bounded, concurrent-worker-safe cleanup; never logs ciphertext or account identifiers. */
export async function cleanupExpiredIdentityProofs(
  db: Kysely<IdentityDatabase> = identityDatabase(),
  now = new Date(),
): Promise<number> {
  const result = await sql<{ id: string }>`WITH expired AS (
    SELECT id FROM identity_signup_transactions WHERE expires_at<=${now}
      AND (phone_ciphertext IS NOT NULL OR delivery_ciphertext IS NOT NULL OR result_ciphertext IS NOT NULL)
    ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) UPDATE identity_signup_transactions AS proof
    SET status='expired',phone_ciphertext=NULL,delivery_ciphertext=NULL,result_ciphertext=NULL
    FROM expired WHERE proof.id=expired.id RETURNING proof.id`.execute(db);
  return result.rows.length;
}
