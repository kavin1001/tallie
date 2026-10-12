import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { PhoneVault } from '@tallie/channels';
import { createDatabase } from '@tallie/db';
import type { AccountPrincipal } from '@tallie/identity';
import {
  SandboxOnboardingService,
  SandboxSendConnectionService,
  SandboxSendService,
  type PaymentDatabase,
} from '@tallie/payments';
import { SocialService, type SocialDatabase } from '@tallie/social';
import { createSandboxGateway } from '../apps/web/src/server/payments/gateway';
import { createSandboxSendGateway } from '../apps/web/src/server/payments/send-gateway';
import {
  readSandboxPaymentsConfiguration,
  SANDBOX_PERMISSIONS,
  SANDBOX_SEND_PERMISSIONS,
} from '../apps/web/src/server/payments/configuration';
import { migrate } from '../packages/db/src/migrate';

loadEnv({ quiet: true });

/**
 * Operator-only service test. It creates fake local identity rows in a new,
 * isolated PostgreSQL schema, then uses the real Natural sandbox gateway.
 * These rows do not prove phone ownership, passkey enrollment, or device use.
 *
 *   npx tsx scripts/verify-sandbox-share.ts --execute-sandbox-share --new
 *   npx tsx scripts/verify-sandbox-share.ts --execute-sandbox-share --resume SCHEMA
 *
 * A resume never creates a replacement expense, deposit, review, or debit.
 * --retry-same-operation explicitly retries an uncertain setup or deposit
 * using the operation identity already persisted by its service.
 */

const SCHEMA_PREFIX = 'tallie_share_verify_';
const DEPOSIT_MINOR = '500';
const SHARE_MINOR = '100';
const WAIT_MS = 60_000;
const POLL_MS = 2_000;
const PHONE = {
  creditor: '+12025550101',
  debtor: '+12025550102',
} as const;
type Role = keyof typeof PHONE;
type Options = { mode: 'new' | 'resume'; schema: string; retrySameOperation: boolean };
type Marker = {
  schema_name: string;
  agent_id: string;
  platform_party_id: string;
  sender_wallet_id: string | null;
  recipient_wallet_id: string | null;
  sender_start_minor: number | null;
  recipient_start_minor: number | null;
};
type ConnectedRow = {
  customer_party_id: string;
  balances: { providerWalletId: string; currency: string }[];
};

class Incomplete extends Error {
  constructor(
    readonly step: string,
    readonly code: string,
  ) {
    super(code);
  }
}

function stableUuid(schema: string, part: string): string {
  const bytes = createHash('sha256').update(`tallie-share-verify-v1:${schema}:${part}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseOptions(argv: string[]): Options {
  if (!argv.includes('--execute-sandbox-share'))
    throw new Incomplete('guard', 'EXPLICIT_SANDBOX_OPT_IN_REQUIRED');
  const isNew = argv.includes('--new');
  const resumeAt = argv.indexOf('--resume');
  if (isNew === (resumeAt !== -1)) throw new Incomplete('guard', 'CHOOSE_NEW_OR_RESUME');
  const retrySameOperation = argv.includes('--retry-same-operation');
  if (retrySameOperation && isNew) throw new Incomplete('guard', 'RETRY_REQUIRES_RESUME');
  const schema = isNew ? `${SCHEMA_PREFIX}${randomBytes(8).toString('hex')}` : argv[resumeAt + 1];
  if (!schema || !/^tallie_share_verify_[a-f0-9]{16}$/.test(schema))
    throw new Incomplete('guard', 'INVALID_ISOLATED_SCHEMA');
  const expected = isNew
    ? ['--execute-sandbox-share', '--new']
    : [
        '--execute-sandbox-share',
        '--resume',
        schema,
        ...(retrySameOperation ? ['--retry-same-operation'] : []),
      ];
  if (argv.length !== expected.length || !expected.every((value) => argv.includes(value)))
    throw new Incomplete('guard', 'UNKNOWN_ARGUMENT');
  return { mode: isNew ? 'new' : 'resume', schema, retrySameOperation };
}

function localDatabaseUrl(
  raw: string | undefined,
  schema: string,
): {
  base: string;
  scoped: string;
} {
  if (!raw) throw new Incomplete('guard', 'LOCAL_DATABASE_REQUIRED');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Incomplete('guard', 'INVALID_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.pathname ||
    url.pathname === '/'
  )
    throw new Incomplete('guard', 'LOOPBACK_POSTGRES_REQUIRED');
  // Override any configured search path. All application rows go into this
  // schema; only CREATE SCHEMA and catalog checks use the base connection.
  url.searchParams.delete('options');
  const base = url.toString();
  url.searchParams.set('options', `-c search_path=${schema}`);
  return { base, scoped: url.toString() };
}

async function prepareSchema(
  base: string,
  scoped: string,
  options: Options,
  agentId: string,
  platformPartyId: string,
): Promise<void> {
  const admin = new Pool({ connectionString: base, max: 1 });
  try {
    if (options.mode === 'new') {
      await admin.query(`CREATE SCHEMA "${options.schema}"`);
    } else {
      const found = await admin.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists',
        [options.schema],
      );
      if (!found.rows[0]?.exists) throw new Incomplete('schema', 'SCHEMA_NOT_FOUND');
    }
  } finally {
    await admin.end();
  }
  if (options.mode === 'new') await migrate(scoped);
  const scopedPool = new Pool({ connectionString: scoped, max: 1 });
  try {
    const current = await scopedPool.query<{ current_schema: string }>(
      'SELECT current_schema() AS current_schema',
    );
    if (current.rows[0]?.current_schema !== options.schema)
      throw new Incomplete('schema', 'SEARCH_PATH_MISMATCH');
    if (options.mode === 'new') {
      await scopedPool.query(`
        CREATE TABLE operator_sandbox_share_fixture (
          id integer PRIMARY KEY CHECK (id=1),
          schema_name text NOT NULL,
          agent_id text NOT NULL,
          platform_party_id text NOT NULL,
          sender_wallet_id text,
          recipient_wallet_id text,
          sender_start_minor integer,
          recipient_start_minor integer,
          created_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((sender_wallet_id IS NULL) =
                 (recipient_wallet_id IS NULL)),
          CHECK ((sender_start_minor IS NULL) =
                 (recipient_start_minor IS NULL))
        )
      `);
      await scopedPool.query(
        'INSERT INTO operator_sandbox_share_fixture(id,schema_name,agent_id,platform_party_id) VALUES(1,$1,$2,$3)',
        [options.schema, agentId, platformPartyId],
      );
    } else {
      const marker = await scopedPool.query<Marker>(
        'SELECT * FROM operator_sandbox_share_fixture WHERE id=1',
      );
      if (
        marker.rows[0]?.schema_name !== options.schema ||
        marker.rows[0]?.agent_id !== agentId ||
        marker.rows[0]?.platform_party_id !== platformPartyId
      )
        throw new Incomplete('schema', 'FIXTURE_BINDING_MISMATCH');
    }
  } finally {
    await scopedPool.end();
  }
}

function actor(schema: string, role: Role, vault: PhoneVault): AccountPrincipal {
  return {
    userId: stableUuid(schema, `${role}-user`),
    sessionId: stableUuid(schema, `${role}-session`),
    phoneHash: vault.lookup(PHONE[role]),
    displayName: role === 'creditor' ? 'Tallie Test Creditor' : 'Tallie Test Debtor',
  };
}

async function fixtureAccounts(
  db: Kysely<PaymentDatabase>,
  schema: string,
  vault: PhoneVault,
): Promise<{ creditor: AccountPrincipal; debtor: AccountPrincipal }> {
  const accounts = {
    creditor: actor(schema, 'creditor', vault),
    debtor: actor(schema, 'debtor', vault),
  };
  await db.transaction().execute(async (tx) => {
    const count = await sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM auth_user
      WHERE id IN (${accounts.creditor.userId}::uuid,${accounts.debtor.userId}::uuid)
    `.execute(tx);
    if (count.rows[0]?.count === 0) {
      for (const role of ['creditor', 'debtor'] as const) {
        const person = accounts[role];
        const phone = PHONE[role];
        await sql`
          INSERT INTO auth_user(id,name,email)
          VALUES(${person.userId}::uuid,${person.displayName},${`${role}@${schema}.invalid`})
        `.execute(tx);
        await sql`
          INSERT INTO identity_phone_bindings(
            user_id,phone_hash,phone_ciphertext,masked_phone,verified_at
          ) VALUES (
            ${person.userId}::uuid,${person.phoneHash},
            ${vault.seal(phone, `${person.userId}:phone`)},
            ${`••• ${phone.slice(-4)}`},${new Date()}
          )
        `.execute(tx);
        await sql`
          INSERT INTO auth_session(
            id,user_id,token,expires_at,assurance_kind,assurance_at
          ) VALUES (
            ${person.sessionId}::uuid,${person.userId}::uuid,${randomUUID()},
            ${new Date(Date.now() + 7 * 86_400_000)},'passkey',${new Date()}
          )
        `.execute(tx);
      }
    } else if (count.rows[0]?.count !== 2) {
      throw new Incomplete('fixture', 'PARTIAL_FIXTURE');
    }
    for (const role of ['creditor', 'debtor'] as const) {
      const person = accounts[role];
      const verified = await sql<{
        phone_hash: string;
        assurance_kind: string;
        user_id: string;
      }>`
        SELECT p.phone_hash,s.assurance_kind,s.user_id
        FROM identity_phone_bindings p
        JOIN auth_session s ON s.user_id=p.user_id
        WHERE p.user_id=${person.userId}::uuid AND s.id=${person.sessionId}::uuid
      `.execute(tx);
      if (
        verified.rows[0]?.phone_hash !== person.phoneHash ||
        verified.rows[0]?.assurance_kind !== 'passkey' ||
        verified.rows[0]?.user_id !== person.userId
      )
        throw new Incomplete('fixture', 'FIXTURE_IDENTITY_CHANGED');
      // Deliberately synthetic assurance for a service-level test only.
      await sql`
        UPDATE auth_session SET assurance_at=${new Date()},
          expires_at=${new Date(Date.now() + 7 * 86_400_000)}
        WHERE id=${person.sessionId}::uuid
      `.execute(tx);
    }
  });
  return accounts;
}

async function ensureConnected(
  service: SandboxOnboardingService | SandboxSendConnectionService,
  person: AccountPrincipal,
  step: string,
  retrySameOperation: boolean,
): Promise<void> {
  let state = await service.state(person);
  if (!state.connection) state = await service.start(person);
  else if (
    state.connection.status === 'unknown' &&
    state.connection.retryAllowed &&
    retrySameOperation
  )
    state = await service.retry(person);
  if (state.connection?.status !== 'connected')
    throw new Incomplete(step, `SETUP_${state.connection?.status ?? 'missing'}`);
}

async function connectionRow(
  db: Kysely<PaymentDatabase>,
  table: 'natural_sandbox_connections' | 'natural_sandbox_send_connections',
  person: AccountPrincipal,
): Promise<ConnectedRow> {
  const row = await sql<ConnectedRow>`
    SELECT customer_party_id,balances FROM ${sql.table(table)}
    WHERE account_id=${person.userId}::uuid AND phone_hash=${person.phoneHash}
      AND status='connected' AND environment='sandbox'
  `.execute(db);
  const connection = row.rows[0];
  if (!connection?.customer_party_id || !connection.balances?.[0]?.providerWalletId)
    throw new Incomplete('connections', 'CONNECTED_WALLET_REQUIRED');
  return connection;
}

async function walletBalance(
  gateway: ReturnType<typeof createSandboxSendGateway>,
  partyId: string,
  walletId: string,
): Promise<number> {
  const wallet = await gateway.getWallet({ customerPartyId: partyId, walletId });
  const available = Number(wallet.balance?.available);
  if (
    wallet.id !== walletId ||
    wallet.partyId !== partyId ||
    wallet.status !== 'active' ||
    wallet.walletType !== 'standard' ||
    wallet.balance?.currency !== 'USD' ||
    !Number.isSafeInteger(available) ||
    available < 0
  )
    throw new Incomplete('balances', 'WALLET_READ_MISMATCH');
  return available;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  return false;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const urls = localDatabaseUrl(process.env.DATABASE_URL, options.schema);
  const config = readSandboxPaymentsConfiguration();
  if (!config) throw new Incomplete('guard', 'SANDBOX_CONFIG_REQUIRED');
  const vault = new PhoneVault(process.env.IDENTITY_ENCRYPTION_KEY ?? '');
  // The schema name is the durable recovery handle. Emit it before any Natural
  // mutation, while never emitting credentials, phones, party IDs or wallet IDs.
  console.log(
    JSON.stringify({ status: 'starting', schema: options.schema, environment: 'sandbox' }),
  );
  await prepareSchema(
    urls.base,
    urls.scoped,
    options,
    config.agent.agentId,
    config.agent.platformPartyId,
  );
  const db = createDatabase(urls.scoped) as unknown as Kysely<PaymentDatabase>;
  try {
    const accounts = await fixtureAccounts(db, options.schema, vault);
    const social = new SocialService(
      db as unknown as Kysely<SocialDatabase>,
      vault,
      'http://localhost:3000',
      undefined,
      false,
      true,
    );
    const readGateway = createSandboxGateway(config);
    const sendSetupGateway = createSandboxGateway(config, undefined, 'send');
    const sendGateway = createSandboxSendGateway(config);
    const receiverSetup = new SandboxOnboardingService(db, readGateway, {
      enabled: true,
      environment: 'sandbox',
      platformPartyId: config.agent.platformPartyId,
      agentId: config.agent.agentId,
      permissions: SANDBOX_PERMISSIONS,
    });
    const senderSetup = new SandboxSendConnectionService(db, sendSetupGateway, {
      enabled: true,
      environment: 'sandbox',
      platformPartyId: config.agent.platformPartyId,
      agentId: config.agent.agentId,
      permissions: SANDBOX_SEND_PERMISSIONS,
    });
    const send = new SandboxSendService(
      db,
      sendGateway,
      config.agent.agentId,
      config.agent.platformPartyId,
    );

    const contact = await social.addContact(
      accounts.creditor,
      { label: 'Tallie Test Debtor', phone: PHONE.debtor },
      stableUuid(options.schema, 'contact-key'),
    );
    const created = await social.createExpense(
      accounts.creditor,
      {
        title: 'Sandbox coffee',
        emoji: '☕',
        category: 'coffee',
        totalMinor: '200',
        participantIds: [accounts.creditor.userId, contact.id],
        method: 'equal',
        paymentEnvironment: 'sandbox',
      },
      stableUuid(options.schema, 'expense-key'),
    );
    const invitation = await social.createInvitation(
      accounts.creditor,
      { contactId: contact.id, expenseId: created.id },
      stableUuid(options.schema, 'invitation-key'),
    );
    const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('token');
    if (!token) throw new Incomplete('social', 'INVITATION_TOKEN_MISSING');
    await social.claimInvitation(accounts.debtor, token);
    const creditorExpense = await social.expense(accounts.creditor.userId, created.id);
    const share = creditorExpense.shares.find((item) => !item.isYou);
    if (
      creditorExpense.paymentEnvironment !== 'sandbox' ||
      !share ||
      share.amountMinor !== SHARE_MINOR ||
      share.status === 'canceled'
    )
      throw new Incomplete('social', 'SHARE_BINDING_MISMATCH');
    console.log(JSON.stringify({ step: 'social', status: 'claimed', shareMinor: SHARE_MINOR }));

    await ensureConnected(
      receiverSetup,
      accounts.creditor,
      'receiver_setup',
      options.retrySameOperation,
    );
    await ensureConnected(senderSetup, accounts.debtor, 'sender_setup', options.retrySameOperation);
    console.log(JSON.stringify({ step: 'connections', status: 'connected' }));

    const source = await connectionRow(db, 'natural_sandbox_send_connections', accounts.debtor);
    const destination = await connectionRow(db, 'natural_sandbox_connections', accounts.creditor);
    const sourceWalletId = source.balances[0]!.providerWalletId;
    const recipientWalletId = destination.balances[0]!.providerWalletId;
    const marker = (
      await sql<Marker>`SELECT * FROM operator_sandbox_share_fixture WHERE id=1`.execute(db)
    ).rows[0]!;
    if (!marker.sender_wallet_id) {
      const [senderBefore, recipientBefore] = await Promise.all([
        walletBalance(sendGateway, source.customer_party_id, sourceWalletId),
        walletBalance(sendGateway, destination.customer_party_id, recipientWalletId),
      ]);
      await sql`
        UPDATE operator_sandbox_share_fixture
        SET sender_wallet_id=${sourceWalletId},recipient_wallet_id=${recipientWalletId},
            sender_start_minor=${senderBefore},recipient_start_minor=${recipientBefore}
        WHERE id=1 AND sender_wallet_id IS NULL
      `.execute(db);
      marker.sender_wallet_id = sourceWalletId;
      marker.recipient_wallet_id = recipientWalletId;
      marker.sender_start_minor = senderBefore;
      marker.recipient_start_minor = recipientBefore;
    }
    if (
      marker.sender_wallet_id !== sourceWalletId ||
      marker.recipient_wallet_id !== recipientWalletId ||
      marker.sender_start_minor === null ||
      marker.recipient_start_minor === null
    )
      throw new Incomplete('balances', 'BASELINE_CHANGED');

    let senderState = await send.state(accounts.debtor);
    if (!senderState.funding) await send.fund(accounts.debtor, DEPOSIT_MINOR);
    else if (
      senderState.funding.status !== 'COMPLETED' &&
      senderState.funding.retryAllowed &&
      options.retrySameOperation
    )
      await send.fund(accounts.debtor, DEPOSIT_MINOR);
    const funded = await waitUntil(async () => {
      senderState = await send.state(accounts.debtor);
      return senderState.funding?.status === 'COMPLETED';
    });
    if (!funded) {
      console.log(
        JSON.stringify({ step: 'deposit', status: senderState.funding?.status ?? 'missing' }),
      );
      throw new Incomplete('deposit', 'DEPOSIT_NOT_COMPLETED');
    }
    if (senderState.funding?.amountMinor !== DEPOSIT_MINOR)
      throw new Incomplete('deposit', 'DEPOSIT_AMOUNT_CHANGED');
    console.log(
      JSON.stringify({ step: 'deposit', status: 'COMPLETED', amountMinor: DEPOSIT_MINOR }),
    );

    const reviewKey = stableUuid(options.schema, 'share-review-key');
    const existingReview = (
      await sql<{ id: string; status: string; share_id: string; amount_minor: number }>`
        SELECT id,status,share_id,amount_minor FROM natural_sandbox_send_reviews
        WHERE account_id=${accounts.debtor.userId}::uuid AND client_request_key=${reviewKey}::uuid
      `.execute(db)
    ).rows[0];
    let reviewId: string;
    if (existingReview) {
      if (
        existingReview.share_id !== share.id ||
        existingReview.amount_minor !== Number(SHARE_MINOR)
      )
        throw new Incomplete('review', 'REVIEW_BINDING_CHANGED');
      reviewId = existingReview.id;
      if (existingReview.status === 'open') {
        const reviewed = await send.reviewShare(accounts.debtor, { shareId: share.id }, reviewKey);
        if (reviewed.review.id !== reviewId || reviewed.review.amountMinor !== SHARE_MINOR)
          throw new Incomplete('review', 'REVIEW_AMOUNT_CHANGED');
      } else if (existingReview.status !== 'confirmed')
        throw new Incomplete('review', 'REVIEW_EXPIRED');
    } else {
      const reviewed = await send.reviewShare(accounts.debtor, { shareId: share.id }, reviewKey);
      if (
        reviewed.review.shareId !== share.id ||
        reviewed.review.amountMinor !== SHARE_MINOR ||
        reviewed.review.recipientName !== accounts.creditor.displayName
      )
        throw new Incomplete('review', 'REVIEW_AMOUNT_CHANGED');
      reviewId = reviewed.review.id;
    }
    console.log(JSON.stringify({ step: 'review', status: 'exact_share_confirmed' }));

    const first = await send.confirmShare(accounts.debtor, { shareId: share.id, reviewId });
    const second = await send.confirmShare(accounts.debtor, { shareId: share.id, reviewId });
    if (first.transfer.id !== second.transfer.id || first.transfer.amountMinor !== SHARE_MINOR)
      throw new Incomplete('confirmation', 'DUPLICATE_CONFIRM_CHANGED');
    const count = await sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM natural_sandbox_sends
      WHERE share_id=${share.id}::uuid
    `.execute(db);
    if (count.rows[0]?.count !== 1) throw new Incomplete('confirmation', 'MULTIPLE_SEND_JOURNALS');
    console.log(
      JSON.stringify({
        step: 'confirmation',
        status: first.transfer.status,
        repeatConfirmationSameSend: true,
        journalCount: 1,
      }),
    );

    let creditorView = await send.shareState(accounts.creditor, share.id);
    let debtorView = await send.shareState(accounts.debtor, share.id);
    const settled = await waitUntil(async () => {
      [creditorView, debtorView] = await Promise.all([
        send.shareState(accounts.creditor, share.id),
        send.shareState(accounts.debtor, share.id),
      ]);
      return creditorView.status === 'paid' && debtorView.status === 'paid';
    });
    if (!settled) {
      console.log(
        JSON.stringify({
          step: 'settlement',
          creditorStatus: creditorView.status,
          debtorStatus: debtorView.status,
        }),
      );
      throw new Incomplete('settlement', 'PAYMENT_NOT_COMPLETED');
    }
    const [creditorProjection, debtorProjection, creditorDashboard, debtorDashboard] =
      await Promise.all([
        social.expense(accounts.creditor.userId, created.id),
        social.expense(accounts.debtor.userId, created.id),
        social.dashboard(accounts.creditor),
        social.dashboard(accounts.debtor),
      ]);
    const creditorShare = creditorProjection.shares.find((item) => item.id === share.id);
    const debtorShare = debtorProjection.shares.find((item) => item.id === share.id);
    if (
      creditorShare?.sandboxPayment?.status !== 'paid' ||
      debtorShare?.sandboxPayment?.status !== 'paid' ||
      creditorDashboard.sandboxSummary.owedToYouMinor !== '0' ||
      creditorDashboard.sandboxSummary.owingMinor !== '0' ||
      debtorDashboard.sandboxSummary.owedToYouMinor !== '0' ||
      debtorDashboard.sandboxSummary.owingMinor !== '0' ||
      creditorDashboard.summary.owedToYouMinor !== '0' ||
      creditorDashboard.summary.owingMinor !== '0' ||
      debtorDashboard.summary.owedToYouMinor !== '0' ||
      debtorDashboard.summary.owingMinor !== '0'
    )
      throw new Incomplete('projection', 'SOCIAL_PROJECTION_MISMATCH');
    const balancesSettled = await waitUntil(async () => {
      const [senderAfter, recipientAfter] = await Promise.all([
        walletBalance(sendGateway, source.customer_party_id, sourceWalletId),
        walletBalance(sendGateway, destination.customer_party_id, recipientWalletId),
      ]);
      return (
        senderAfter === marker.sender_start_minor! + Number(DEPOSIT_MINOR) - Number(SHARE_MINOR) &&
        recipientAfter === marker.recipient_start_minor! + Number(SHARE_MINOR)
      );
    });
    if (!balancesSettled) throw new Incomplete('balances', 'PROVIDER_BALANCES_NOT_SETTLED');
    console.log(
      JSON.stringify({
        status: 'verified',
        schema: options.schema,
        evidence: 'service_level_natural_sandbox',
        depositMinor: DEPOSIT_MINOR,
        exactShareMinor: SHARE_MINOR,
        bothSocialProjections: 'paid',
        bothDashboardSandboxSummaries: 'zero',
        bothDashboardManualSummaries: 'zero',
        duplicateConfirm: 'one_send_journal',
        providerBalances: 'expected_delta_verified',
        identity: 'synthetic_fixture_only',
      }),
    );
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  const safe = error instanceof Incomplete ? error : null;
  console.error(
    JSON.stringify({
      status: 'incomplete',
      step: safe?.step ?? 'unavailable',
      reason: safe?.code ?? 'UNEXPECTED_FAILURE',
      note: 'The isolated schema and operation journal were retained. Resume the same schema; do not create a replacement test on an uncertain result.',
    }),
  );
  process.exitCode = 1;
});
