import { createHash } from 'node:crypto';
import type { PhoneVault } from '@tallie/channels';
import type { Database } from '@tallie/db';
import type { CreateExpenseInput } from '@tallie/db/contracts';
import {
  identityDatabase,
  identityVault,
  IdentityError,
  type AccountPrincipal,
  type IdentityDatabase,
} from '@tallie/identity';
import {
  configuredMessagingService,
  messageGrantLockKey,
  providerAccountFingerprint,
  MessagingError,
  type MessageIdentity,
  type MessagingDatabase,
  type MessagingHooks,
  type MessagingService,
} from '@tallie/messaging';
import { createOwnedReceipt, readOwnedReceipt } from '@tallie/receipts/owned';
import { ReceiptError } from '@tallie/receipts';
import { SocialService, expenseInput, type SocialDatabase } from '@tallie/social';
import { sql, type Kysely, type QueryExecutorProvider } from 'kysely';

export type ApplicationDatabase = Database & IdentityDatabase & SocialDatabase & MessagingDatabase;
export interface MessageApplicationDependencies {
  db: Kysely<ApplicationDatabase>;
  vault: PhoneVault;
  providerAccount: string;
  origin: string;
  now?: () => Date;
  receiptDirectory?: string;
}

function configuredDependencies(): MessageApplicationDependencies {
  return {
    db: identityDatabase() as unknown as Kysely<ApplicationDatabase>,
    vault: identityVault(),
    providerAccount: providerAccountFingerprint(process.env.SENDBLUE_API_KEY_ID ?? ''),
    origin: process.env.APP_ORIGIN ?? '',
  };
}

function nowFor(deps: MessageApplicationDependencies): Date {
  return deps.now?.() ?? new Date();
}

/** A readable phone number never suffices: the originating strong session and
 * the account's current immutable verified binding must both still match. */
export async function validateMessageIdentity(
  identity: MessageIdentity,
  deps: MessageApplicationDependencies,
): Promise<boolean> {
  if (
    identity.accountId !== identity.personId ||
    identity.bindingEpoch !== 0 ||
    !/^\+1[2-9]\d{9}$/.test(identity.phone)
  )
    return false;
  const row = await sql<{ id: string }>`SELECT s.id FROM auth_session s
    JOIN identity_phone_bindings p ON p.user_id=s.user_id
    WHERE s.id=${identity.sessionId} AND s.user_id=${identity.accountId}
      AND s.expires_at>${nowFor(deps)} AND s.assurance_kind IN ('passkey','recovery')
      AND p.phone_hash=${deps.vault.lookup(identity.phone)}`.execute(deps.db);
  return row.rows.length === 1;
}

/** Same phone advisory key is held by STOP/START and grant revocation. The
 * caller retains all locks through its receipt/publication transaction. */
export async function lockCurrentMessageGrant(
  executor: QueryExecutorProvider,
  identity: MessageIdentity,
  deps: MessageApplicationDependencies,
): Promise<void> {
  if (identity.accountId !== identity.personId || identity.bindingEpoch !== 0)
    throw new MessagingError('CHANNEL_IDENTITY_REQUIRED', 403);
  const candidate = await sql<{
    id: string;
    phone_hash: string;
  }>`SELECT id, phone_hash FROM message_grants
    WHERE provider_account=${deps.providerAccount} AND account_id=${identity.accountId}
      AND person_id=${identity.personId}::uuid AND session_id=${identity.sessionId}
      AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`.execute(executor);
  const grant = candidate.rows[0];
  if (!grant) throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${messageGrantLockKey(deps.providerAccount, grant.phone_hash)}, 0))`.execute(
    executor,
  );
  const locked = await sql<{ id: string }>`SELECT id FROM message_grants WHERE id=${grant.id}::uuid
    AND revoked_at IS NULL AND expires_at>${nowFor(deps)} AND binding_epoch=${identity.bindingEpoch}
    FOR UPDATE`.execute(executor);
  if (!locked.rows.length) throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
  const account = await sql<{ id: string }>`SELECT s.id FROM auth_session s
    JOIN identity_phone_bindings p ON p.user_id=s.user_id
    WHERE s.id=${identity.sessionId} AND s.user_id=${identity.accountId}
      AND s.expires_at>${nowFor(deps)} AND s.assurance_kind IN ('passkey','recovery')
      AND p.phone_hash=${deps.vault.lookup(identity.phone)}
    FOR SHARE OF s,p`.execute(executor);
  const stopped = await sql<{ stopped_at: Date | null }>`SELECT stopped_at FROM message_preferences
    WHERE provider_account=${deps.providerAccount} AND phone_hash=${grant.phone_hash}`.execute(
    executor,
  );
  if (!account.rows.length || stopped.rows[0]?.stopped_at)
    throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
}

function socialService(deps: MessageApplicationDependencies): SocialService {
  return new SocialService(
    deps.db as unknown as Kysely<SocialDatabase>,
    deps.vault,
    deps.origin,
    deps.now ?? (() => new Date()),
    process.env.RECEIPTS_ENABLED === 'true',
  );
}

export function createApplicationMessageHooks(
  deps: MessageApplicationDependencies,
): MessagingHooks {
  const social = socialService(deps);
  return {
    validateIdentity: (identity) => validateMessageIdentity(identity, deps),
    resolveContacts: async (identity, names) => {
      if (!(await validateMessageIdentity(identity, deps)))
        throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
      return social.resolveContacts(identity.accountId, names);
    },
    ingestReceipt: async ({ identity, messageId, bytes, contentType }) => {
      if (process.env.RECEIPTS_ENABLED !== 'true')
        throw new MessagingError('RECEIPT_UNAVAILABLE', 503);
      const options = {
        db: deps.db as unknown as Kysely<Database>,
        ...(deps.receiptDirectory ? { directory: deps.receiptDirectory } : {}),
      };
      const receipt = await createOwnedReceipt(
        identity.accountId,
        { contentBase64: bytes.toString('base64'), contentType },
        `message_${messageId}`,
        (tx) => lockCurrentMessageGrant(tx, identity, deps),
        options,
      );
      return { receiptId: receipt.id };
    },
    readReceipt: async (identity, receiptId) => {
      if (!(await validateMessageIdentity(identity, deps)))
        throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
      const receipt = await readOwnedReceipt(
        identity.accountId,
        receiptId,
        deps.db as unknown as Kysely<Database>,
      ).catch((error: unknown) => {
        if (error instanceof ReceiptError && error.code === 'NOT_FOUND') return null;
        throw error;
      });
      if (!receipt) return { status: 'failed' };
      if (!receipt.proposal) return { status: receipt.status };
      return {
        status: receipt.status,
        title: receipt.proposal.title,
        totalMinor: receipt.proposal.totalMinor,
        currency: receipt.proposal.currency,
        warnings: receipt.proposal.warnings,
      };
    },
    publishEqualSplit: async ({ identity, draftId, title, totalMinor, participantIds }) => {
      const user = await deps.db
        .selectFrom('auth_user')
        .select('name')
        .where('id', '=', identity.accountId)
        .executeTakeFirstOrThrow();
      const expense = await social.createExpenseFromChannel(
        {
          userId: identity.accountId,
          phoneHash: deps.vault.lookup(identity.phone),
          displayName: user.name,
        },
        { title, totalMinor, participantIds, method: 'equal', emoji: '🍽', category: 'dinner' },
        `message_${draftId}`,
        (tx) => lockCurrentMessageGrant(tx, identity, deps),
      );
      return { expenseId: expense.id };
    },
    notificationEligible: async (accountId, reference) => {
      const share = await deps.db
        .selectFrom('social_shares')
        .select('id')
        .where('id', '=', reference)
        .where('user_id', '=', accountId)
        .where('is_payer', '=', false)
        .where('canceled_at', 'is', null)
        .where('amount_minor', '>', '0')
        .executeTakeFirst();
      return !!share;
    },
  };
}

let messaging: MessagingService | undefined;
export function getMessagingService(): MessagingService {
  if (!messaging) {
    const deps = configuredDependencies();
    messaging = configuredMessagingService(
      deps.db as unknown as Kysely<MessagingDatabase>,
      createApplicationMessageHooks(deps),
    );
  }
  return messaging;
}

export async function currentMessageIdentity(
  principal: AccountPrincipal,
  deps = configuredDependencies(),
): Promise<MessageIdentity> {
  const binding = await deps.db
    .selectFrom('identity_phone_bindings')
    .selectAll()
    .where('user_id', '=', principal.userId)
    .where('phone_hash', '=', principal.phoneHash)
    .executeTakeFirst();
  if (!binding) throw new IdentityError('AUTH_REQUIRED', 'Sign in to connect Messages.', 401);
  const identity = {
    accountId: principal.userId,
    personId: principal.userId,
    sessionId: principal.sessionId,
    phone: deps.vault.open(binding.phone_ciphertext, `${principal.userId}:phone`),
    bindingEpoch: 0,
  };
  if (!(await validateMessageIdentity(identity, deps)))
    throw new IdentityError('AUTH_REQUIRED', 'Sign in to connect Messages.', 401);
  return identity;
}

export async function requireFreshMessageEnrollment(
  principal: AccountPrincipal,
  deps = configuredDependencies(),
): Promise<MessageIdentity> {
  const identity = await currentMessageIdentity(principal, deps);
  const cutoff = new Date(nowFor(deps).getTime() - 15 * 60_000);
  const session = await deps.db
    .selectFrom('auth_session')
    .select(['assurance_at', 'phone_verified_at'])
    .where('id', '=', principal.sessionId)
    .executeTakeFirst();
  if (!session?.assurance_at || session.assurance_at <= cutoff)
    throw new IdentityError(
      'STEP_UP_REQUIRED',
      'Confirm it’s you with your passkey to connect Messages.',
      403,
    );
  if (!session.phone_verified_at || session.phone_verified_at <= cutoff)
    throw new IdentityError(
      'FRESH_PHONE_PROOF_REQUIRED',
      'Verify your current phone and sign in again to connect Messages.',
      403,
    );
  return identity;
}

export async function seedRequestNotifications(
  limit = 50,
  service = getMessagingService(),
  deps = configuredDependencies(),
): Promise<number> {
  const rows = await sql<{ user_id: string; share_id: string }>`
    SELECT s.user_id, s.id AS share_id FROM social_shares s
    JOIN message_grants g ON g.account_id=s.user_id::text
    JOIN auth_session origin_session ON origin_session.id::text=g.session_id
    WHERE s.user_id IS NOT NULL AND NOT s.is_payer AND s.amount_minor>0 AND s.canceled_at IS NULL
      AND g.provider_account=${deps.providerAccount} AND g.revoked_at IS NULL
      AND g.expires_at>${nowFor(deps)} AND g.notifications
      AND origin_session.user_id=s.user_id AND origin_session.expires_at>${nowFor(deps)}
      AND origin_session.assurance_kind IN ('passkey','recovery')
      AND NOT EXISTS (SELECT 1 FROM message_outbox o JOIN message_grants old_grant ON old_grant.id=o.grant_id
        WHERE o.provider_account=${deps.providerAccount} AND o.reference=s.id::text
          AND o.kind='notification' AND old_grant.account_id=s.user_id::text)
    ORDER BY s.created_at ASC, s.id ASC LIMIT ${Math.max(1, Math.min(limit, 100))}`.execute(
    deps.db,
  );
  for (const row of rows.rows)
    await service.enqueueRequestNotification(
      row.user_id,
      row.share_id,
      `${row.share_id}:created:v1`,
    );
  return rows.rows.length;
}

export async function publishMessageDraft(
  principal: AccountPrincipal,
  draftId: string,
  version: number,
  input: CreateExpenseInput,
  service = getMessagingService(),
  deps = configuredDependencies(),
): Promise<{ expenseId: string }> {
  await currentMessageIdentity(principal, deps);
  const parsed = expenseInput.parse(input);
  const inputHash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  return service.publishDraftFromWeb(
    principal.userId,
    draftId,
    version,
    inputHash,
    parsed,
    async () => {
      const expense = await socialService(deps).createExpense(
        principal,
        parsed,
        `message_${draftId}`,
      );
      return { expenseId: expense.id };
    },
  );
}
export async function resumeMessageDraft(
  principal: AccountPrincipal,
  draftId: string,
  service = getMessagingService(),
  deps = configuredDependencies(),
): Promise<{ expenseId: string }> {
  await currentMessageIdentity(principal, deps);
  return service.resumeDraftFromWeb(principal.userId, draftId, async (input) => {
    const expense = await socialService(deps).createExpense(principal, input, `message_${draftId}`);
    return { expenseId: expense.id };
  });
}
export async function resolveMessageRequest(
  principal: AccountPrincipal,
  shareId: string,
  deps = configuredDependencies(),
): Promise<{ expenseId: string }> {
  await currentMessageIdentity(principal, deps);
  const row = await deps.db
    .selectFrom('social_shares')
    .innerJoin('social_expenses', 'social_expenses.id', 'social_shares.expense_id')
    .select('social_shares.expense_id')
    .where('social_shares.id', '=', shareId)
    .where((eb) =>
      eb.or([
        eb('social_shares.user_id', '=', principal.userId),
        eb('social_expenses.owner_user_id', '=', principal.userId),
      ]),
    )
    .executeTakeFirst();
  if (!row) throw new MessagingError('MESSAGE_REQUEST_NOT_FOUND', 404);
  return { expenseId: row.expense_id };
}
