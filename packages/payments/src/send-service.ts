import { randomUUID } from 'node:crypto';
import { phoneDemoEnabled, type AccountPrincipal } from '@tallie/identity';
import { sql, type Kysely } from 'kysely';
import { SandboxGatewayError, type SandboxCustomer, type SandboxWallet } from './gateway';
import type { PaymentDatabase, StoredSandboxBalance } from './schema';
import { paymentSubmissionsAllowed } from './operations';
import { saveSandboxPaymentObservation } from './payment-observation';

const MAX_TEST_CENTS = 10_000;
const REVIEW_TTL_MS = 10 * 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const SEND_PERMISSIONS = [
  'party.read',
  'wallets.read',
  'wallets.balance',
  'payments.read',
  'payments.create',
] as const;

type Connection = {
  id: string;
  account_id: string;
  phone_hash: string;
  platform_party_id: string;
  agent_id: string;
  permissions: string[];
  status: string;
  customer_party_id: string | null;
  balances: StoredSandboxBalance[];
  updated_at: Date;
};
type Review = {
  id: string;
  account_id: string;
  client_request_key: string;
  share_id: string | null;
  share_attempt_snapshot: string;
  phone_hash: string;
  sender_connection_id: string;
  sender_party_id: string;
  sender_wallet_id: string;
  recipient_account_id: string | null;
  recipient_party_id: string;
  recipient_name: string;
  recipient_phone_last4: string | null;
  amount_minor: number;
  note: string;
  status: 'open' | 'confirmed' | 'expired';
  created_at: Date;
  expires_at: Date;
};
type Send = {
  id: string;
  review_id: string;
  share_id: string | null;
  attempt_sequence: string;
  account_id: string;
  operation_id: string;
  idempotency_key: string;
  provider_payment_id: string | null;
  status: string;
  first_submission_at: Date | null;
  lease_until: Date | null;
  generation: number;
  created_at: Date;
  updated_at: Date;
};
type ReconcileRow = Send &
  Pick<
    Review,
    | 'sender_party_id'
    | 'recipient_party_id'
    | 'amount_minor'
    | 'note'
    | 'sender_wallet_id'
    | 'sender_connection_id'
    | 'recipient_account_id'
    | 'recipient_name'
    | 'recipient_phone_last4'
    | 'phone_hash'
    | 'expires_at'
  >;
type Funding = {
  id: string;
  account_id: string;
  sender_connection_id: string;
  customer_party_id: string;
  wallet_id: string;
  amount_minor: number;
  operation_id: string;
  idempotency_key: string;
  provider_transfer_id: string | null;
  status: string;
  first_submission_at: Date | null;
  lease_until: Date | null;
  generation: number;
};
type Recipient = {
  accountId: string;
  name: string;
  phoneLast4: string | null;
  partyId: string;
};

type SocialExpense = {
  id: string;
  owner_user_id: string;
  payer_name: string;
  title: string;
  payment_environment: 'manual' | 'sandbox';
};
type SocialShare = {
  id: string;
  expense_id: string;
  user_id: string | null;
  phone_hash: string;
  amount_minor: string;
  is_payer: boolean;
  canceled_at: Date | null;
};
type ShareBinding = {
  expense: SocialExpense;
  share: SocialShare;
  recipient: Recipient | null;
};

export interface SandboxShareState {
  shareId: string;
  expenseId: string;
  amountMinor: string;
  status:
    | 'manual'
    | 'unpaid'
    | 'reviewing'
    | 'processing'
    | 'unknown'
    | 'paid'
    | 'returned'
    | 'failed'
    | 'canceled';
  transfer: {
    id: string;
    reviewId: string;
    amountMinor: string;
    status: string;
    createdAt: string;
  } | null;
  canReview: boolean;
  senderSetupRequired: boolean;
  recipientSetupRequired: boolean;
  sourceAvailableMinor: string | null;
  funding: { status: string; amountMinor: string; retryAllowed: boolean } | null;
}

export interface SandboxPayment {
  id: string;
  amount: number;
  currency: 'USD';
  status: string;
  senderPartyId: string | null;
  recipientPartyId: string | null;
  senderAgentId: string | null;
  paymentRequestId: string | null;
  tags: Record<string, string>;
}
export interface SandboxSendGateway {
  getCustomer(partyId: string): Promise<SandboxCustomer>;
  getWallet(input: { customerPartyId: string; walletId: string }): Promise<SandboxWallet>;
  listWallets(customerPartyId: string): Promise<SandboxWallet[]>;
  fund(input: {
    customerPartyId: string;
    walletId: string;
    amount: number;
    operationId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; amount: number; currency: 'USD' }>;
  send(input: {
    senderPartyId: string;
    walletId: string;
    recipientPartyId: string;
    amount: number;
    description: string;
    operationId: string;
    idempotencyKey: string;
  }): Promise<SandboxPayment>;
  getPayment(input: {
    senderPartyId: string;
    recipientPartyId: string;
    amount: number;
    paymentId: string;
  }): Promise<SandboxPayment>;
  listPayments(input: {
    senderPartyId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ payments: SandboxPayment[]; hasMore: boolean; nextCursor: string | null }>;
}

export class SandboxSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'SandboxSendError';
  }
}

export interface SandboxSendState {
  available: boolean;
  connection: {
    status: 'not_started' | 'setting_up' | 'ready' | 'unknown' | 'blocked';
    retryAllowed: boolean;
    balances: { id: string; currency: 'USD'; availableMinor: string | null }[];
  } | null;
  recipients: { accountId: string; name: string; phoneLast4: string | null }[];
  funding: { status: string; amountMinor: string; retryAllowed: boolean } | null;
  transfers: {
    id: string;
    reviewId: string;
    recipientName: string;
    amountMinor: string;
    status: string;
    createdAt: string;
  }[];
}

const cents = (value: string) => {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > MAX_TEST_CENTS)
    throw new SandboxSendError('INVALID_AMOUNT', 'Enter an amount from $0.01 to $100.00.', 400);
  return Number(value);
};
const permitted = (actual: readonly string[], required: readonly string[]) =>
  required.every((permission) => actual.includes(permission));

/** A strictly synthetic payment lab. It never updates social shares or live balances. */
export class SandboxSendService {
  constructor(
    private readonly db: Kysely<PaymentDatabase>,
    private readonly gateway: SandboxSendGateway,
    private readonly agentId: string,
    private readonly platformPartyId: string,
    private readonly clock = () => new Date(),
  ) {
    if (!agentId || !platformPartyId) throw new Error('Sandbox send configuration is incomplete.');
  }

  private async authorize(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal) {
    // Test dollars only. This narrow phone-demo exception is never payment authority for production.
    const rows = await sql<{ id: string }>`
      SELECT s.id FROM auth_session s
      JOIN auth_user u ON u.id=s.user_id
      JOIN identity_phone_bindings p ON p.user_id=u.id
      WHERE s.id=${actor.sessionId}::uuid AND s.user_id=${actor.userId}::uuid
        AND s.expires_at>${this.clock()} AND p.phone_hash=${actor.phoneHash}
        AND (s.assurance_kind IN ('passkey','recovery') OR (
          ${phoneDemoEnabled()} AND s.assurance_kind='phone_demo' AND u.phone_demo
          AND NOT EXISTS(SELECT 1 FROM auth_passkey WHERE user_id=u.id)
        ))
      FOR SHARE OF s,u,p
    `.execute(tx);
    if (!rows.rows.length)
      throw new SandboxSendError('AUTH_REQUIRED', 'Sign in again to continue.', 401);
  }

  private async connection(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal) {
    const row = await sql<Connection>`
      SELECT * FROM natural_sandbox_send_connections
      WHERE account_id=${actor.userId}::uuid
    `.execute(tx);
    const connection = row.rows[0] ?? null;
    if (
      connection &&
      (connection.phone_hash !== actor.phoneHash ||
        connection.agent_id !== this.agentId ||
        connection.platform_party_id !== this.platformPartyId ||
        !permitted(connection.permissions, SEND_PERMISSIONS))
    )
      throw new SandboxSendError(
        'SANDBOX_CONFIGURATION_CHANGED',
        'This test payment setup needs a review.',
      );
    return connection;
  }

  private ready(connection: Connection | null): asserts connection is Connection & {
    customer_party_id: string;
  } {
    if (!connection || connection.status !== 'connected' || !connection.customer_party_id)
      throw new SandboxSendError(
        'TEST_ACCOUNT_REQUIRED',
        'Set up your test sending account first.',
      );
    if (connection.customer_party_id === this.platformPartyId)
      throw new SandboxSendError('SANDBOX_CONFIGURATION_CHANGED', 'Test setup needs a review.');
  }

  private async verifiedSender(connection: Connection) {
    this.ready(connection);
    const customer = await this.gateway.getCustomer(connection.customer_party_id);
    if (
      customer.id !== connection.customer_party_id ||
      customer.delegation.status !== 'ACTIVE' ||
      !permitted(customer.delegation.permissions, SEND_PERMISSIONS) ||
      !customer.agents.some(
        (agent) =>
          agent.id === this.agentId &&
          agent.status === 'ACTIVE' &&
          permitted(agent.permissions, SEND_PERMISSIONS),
      )
    )
      throw new SandboxSendError('TEST_ACCESS_CHANGED', 'Test payment access changed.');
    const wallets = await this.gateway.listWallets(connection.customer_party_id);
    const walletIds = new Set(connection.balances.map((balance) => balance.providerWalletId));
    return wallets.filter(
      (wallet) =>
        wallet.partyId === connection.customer_party_id &&
        wallet.status === 'active' &&
        wallet.walletType === 'standard' &&
        walletIds.has(wallet.id),
    );
  }

  private async verifiedRecipient(partyId: string) {
    const customer = await this.gateway.getCustomer(partyId);
    if (
      customer.id !== partyId ||
      customer.delegation.status !== 'ACTIVE' ||
      !customer.delegation.permissions.includes('party.read') ||
      !customer.agents.some(
        (agent) =>
          agent.id === this.agentId &&
          agent.status === 'ACTIVE' &&
          agent.permissions.includes('party.read'),
      )
    )
      throw new SandboxSendError('RECIPIENT_CHANGED', 'The test recipient is no longer available.');
  }

  private async recipients(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal) {
    const result = await sql<{
      account_id: string;
      name: string;
      masked_phone: string;
      customer_party_id: string;
    }>`
      SELECT c.connected_user_id AS account_id, c.label AS name,
             p.masked_phone, n.customer_party_id
      FROM social_contacts c
      JOIN identity_phone_bindings p ON p.user_id=c.connected_user_id
      JOIN natural_sandbox_connections n ON n.account_id=c.connected_user_id
        AND n.phone_hash=p.phone_hash AND n.status='connected'
      WHERE c.owner_user_id=${actor.userId}::uuid AND c.connected_user_id IS NOT NULL
      ORDER BY c.label, c.id LIMIT 100
    `.execute(tx);
    const recipients: Recipient[] = result.rows.map((row) => ({
      accountId: row.account_id,
      name: row.name,
      phoneLast4: row.masked_phone.slice(-4),
      partyId: row.customer_party_id,
    }));
    const self = await sql<{ customer_party_id: string }>`
      SELECT n.customer_party_id FROM natural_sandbox_connections n
      JOIN identity_phone_bindings p ON p.user_id=n.account_id AND p.phone_hash=n.phone_hash
      WHERE n.account_id=${actor.userId}::uuid AND n.status='connected'
    `.execute(tx);
    if (self.rows[0]?.customer_party_id)
      recipients.unshift({
        accountId: 'sandbox-fixture',
        name: 'Your test receiving account',
        phoneLast4: null,
        partyId: self.rows[0].customer_party_id,
      });
    return recipients;
  }

  /** The expense lock precedes the share lock, as in social cancellation. */
  private async shareBinding(
    tx: Kysely<PaymentDatabase>,
    actor: AccountPrincipal,
    shareId: string,
    lock: boolean,
  ): Promise<ShareBinding> {
    const candidate = (
      await sql<{ expense_id: string }>`
        SELECT expense_id FROM social_shares WHERE id=${shareId}::uuid
      `.execute(tx)
    ).rows[0];
    if (!candidate)
      throw new SandboxSendError('SHARE_NOT_FOUND', 'This share is unavailable.', 404);
    const expense = (
      await (
        lock
          ? sql<SocialExpense>`
            SELECT id,owner_user_id,payer_name,title,payment_environment
            FROM social_expenses WHERE id=${candidate.expense_id}::uuid FOR UPDATE
          `
          : sql<SocialExpense>`
            SELECT id,owner_user_id,payer_name,title,payment_environment
            FROM social_expenses WHERE id=${candidate.expense_id}::uuid
          `
      ).execute(tx)
    ).rows[0];
    const share = (
      await (
        lock
          ? sql<SocialShare>`
            SELECT id,expense_id,user_id,phone_hash,amount_minor,is_payer,canceled_at
            FROM social_shares WHERE id=${shareId}::uuid AND expense_id=${candidate.expense_id}::uuid
            FOR UPDATE
          `
          : sql<SocialShare>`
            SELECT id,expense_id,user_id,phone_hash,amount_minor,is_payer,canceled_at
            FROM social_shares WHERE id=${shareId}::uuid AND expense_id=${candidate.expense_id}::uuid
          `
      ).execute(tx)
    ).rows[0];
    if (
      !expense ||
      !share ||
      share.is_payer ||
      (expense.owner_user_id !== actor.userId &&
        (share.user_id !== actor.userId || share.phone_hash !== actor.phoneHash))
    )
      throw new SandboxSendError('SHARE_NOT_FOUND', 'This share is unavailable.', 404);
    const receiving = (
      await sql<{
        customer_party_id: string;
        masked_phone: string;
      }>`
        SELECT n.customer_party_id,p.masked_phone
        FROM identity_phone_bindings p
        JOIN natural_sandbox_connections n
          ON n.account_id=p.user_id AND n.phone_hash=p.phone_hash
        WHERE p.user_id=${expense.owner_user_id}::uuid
          AND n.status='connected' AND n.environment='sandbox'
          AND n.platform_party_id=${this.platformPartyId} AND n.agent_id=${this.agentId}
          AND n.customer_party_id<>${this.platformPartyId}
          AND n.permissions @> '["party.read","wallets.read","wallets.balance"]'::jsonb
      `.execute(tx)
    ).rows[0];
    return {
      expense,
      share,
      recipient: receiving?.customer_party_id
        ? {
            accountId: expense.owner_user_id,
            name: expense.payer_name,
            phoneLast4: receiving.masked_phone.slice(-4),
            partyId: receiving.customer_party_id,
          }
        : null,
    };
  }

  private assertPayableShare(binding: ShareBinding, actor: AccountPrincipal): Recipient {
    if (binding.share.user_id !== actor.userId || binding.share.phone_hash !== actor.phoneHash)
      throw new SandboxSendError('SHARE_NOT_FOUND', 'This share is unavailable.', 404);
    if (binding.expense.payment_environment !== 'sandbox')
      throw new SandboxSendError('SHARE_NOT_PAYABLE', 'This split is not a test payment.', 409);
    if (binding.share.canceled_at)
      throw new SandboxSendError('SHARE_CANCELED', 'This share was canceled.', 409);
    const amount = Number(binding.share.amount_minor);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_TEST_CENTS)
      throw new SandboxSendError(
        'SHARE_AMOUNT_UNAVAILABLE',
        'This share cannot be paid with test dollars.',
        409,
      );
    if (!binding.recipient)
      throw new SandboxSendError(
        'RECIPIENT_SETUP_REQUIRED',
        'The person who paid needs to set up a test receiving account.',
        409,
      );
    return binding.recipient;
  }

  private async latestShareSend(
    tx: Kysely<PaymentDatabase>,
    shareId: string,
  ): Promise<Send | null> {
    return (
      (
        await sql<Send>`
        SELECT * FROM natural_sandbox_sends WHERE share_id=${shareId}::uuid
        ORDER BY attempt_sequence DESC LIMIT 1
      `.execute(tx)
      ).rows[0] ?? null
    );
  }

  private shareAttemptReleased(send: Send): boolean {
    return send.provider_payment_id !== null && ['FAILED', 'RETURNED'].includes(send.status);
  }

  private shareNote(expense: SocialExpense): string {
    return Array.from(expense.title).slice(0, 80).join('');
  }

  private async assertShareAvailable(
    tx: Kysely<PaymentDatabase>,
    shareId: string,
  ): Promise<Send | null> {
    const latest = await this.latestShareSend(tx, shareId);
    if (latest && !this.shareAttemptReleased(latest))
      throw new SandboxSendError(
        'SHARE_PAYMENT_IN_PROGRESS',
        'This share already has a test payment to check.',
        409,
      );
    return latest;
  }

  private async getFunding(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal) {
    const result = await sql<Funding>`
      SELECT * FROM natural_sandbox_funding WHERE account_id=${actor.userId}::uuid
    `.execute(tx);
    return result.rows[0] ?? null;
  }

  private fundingStatus(funding: Funding): string {
    return funding.status === 'submitting' &&
      (!funding.lease_until || funding.lease_until <= this.clock())
      ? 'unknown'
      : funding.status;
  }

  private fundingRetryAllowed(funding: Funding): boolean {
    const elapsed = funding.first_submission_at
      ? this.clock().getTime() - funding.first_submission_at.getTime()
      : 0;
    return (
      funding.provider_transfer_id === null &&
      ['prepared', 'unknown', 'FAILED'].includes(this.fundingStatus(funding)) &&
      elapsed >= 0 &&
      elapsed < RETRY_WINDOW_MS
    );
  }

  /** Explicit, once-per-account sandbox deposit. A retry reuses the saved provider key. */
  async fund(actor: AccountPrincipal, amountMinor: string): Promise<void> {
    const amount = cents(amountMinor);
    const claimed = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`natural-fund:${actor.userId}`},0))`.execute(
        tx,
      );
      const connection = await this.connection(tx, actor);
      this.ready(connection);
      const wallet = connection.balances[0];
      if (!wallet)
        throw new SandboxSendError('TEST_WALLET_REQUIRED', 'No test wallet is available.');
      let funding = (
        await sql<Funding>`
          SELECT * FROM natural_sandbox_funding WHERE account_id=${actor.userId}::uuid FOR UPDATE
        `.execute(tx)
      ).rows[0];
      if (funding) {
        if (
          funding.amount_minor !== amount ||
          funding.sender_connection_id !== connection.id ||
          funding.customer_party_id !== connection.customer_party_id ||
          funding.wallet_id !== wallet.providerWalletId
        )
          throw new SandboxSendError(
            'TEST_DEPOSIT_EXISTS',
            'This account already has a test deposit request.',
          );
        // A rejected preflight has no provider transfer. An explicit retry keeps
        // the original deposit identity; a canonical failed transfer is terminal.
        if (
          funding.provider_transfer_id !== null ||
          !['prepared', 'unknown', 'FAILED'].includes(this.fundingStatus(funding))
        )
          return null;
        if (
          funding.first_submission_at &&
          (funding.first_submission_at > this.clock() ||
            this.clock().getTime() - funding.first_submission_at.getTime() >= RETRY_WINDOW_MS)
        )
          throw new SandboxSendError(
            'TEST_DEPOSIT_REVIEW',
            'This test deposit needs a closer look before another attempt.',
          );
        if (funding.lease_until && funding.lease_until > this.clock()) return null;
      } else {
        const id = randomUUID();
        funding = (
          await sql<Funding>`
            INSERT INTO natural_sandbox_funding
              (id,account_id,sender_connection_id,customer_party_id,wallet_id,
               amount_minor,operation_id,idempotency_key,status,generation,created_at,updated_at)
            VALUES (${id}::uuid,${actor.userId}::uuid,${connection.id}::uuid,
                    ${connection.customer_party_id},${wallet.providerWalletId},${amount},
                    ${randomUUID()}::uuid,${randomUUID()}::uuid,'prepared',0,${this.clock()},${this.clock()})
            RETURNING *
          `.execute(tx)
        ).rows[0]!;
      }
      if (!(await paymentSubmissionsAllowed(tx, 'sandbox')))
        throw new SandboxSendError('PAYMENTS_PAUSED', 'Test payments are temporarily paused.', 503);
      const now = this.clock();
      const previousStatus = this.fundingStatus(funding);
      const submitting = (
        await sql<Funding>`
          UPDATE natural_sandbox_funding
          SET status='submitting',first_submission_at=COALESCE(first_submission_at,${now}),
              lease_until=${new Date(now.getTime() + 30_000)},
              generation=generation+1,updated_at=${now}
          WHERE id=${funding.id}::uuid RETURNING *
        `.execute(tx)
      ).rows[0]!;
      return { ...submitting, previousStatus };
    });
    if (!claimed) return;
    try {
      const result = await this.gateway.fund({
        customerPartyId: claimed.customer_party_id,
        walletId: claimed.wallet_id,
        amount: claimed.amount_minor,
        operationId: claimed.operation_id,
        idempotencyKey: claimed.idempotency_key,
      });
      if (result.amount !== amount || result.currency !== 'USD')
        throw new SandboxSendError('PROVIDER_MISMATCH', 'Test deposit needs a closer look.');
      await sql`
        UPDATE natural_sandbox_funding
        SET provider_transfer_id=${result.id},status=${result.status},
            lease_until=NULL,updated_at=${this.clock()}
        WHERE id=${claimed.id}::uuid AND generation=${claimed.generation}
      `.execute(this.db);
    } catch (error) {
      // A later rejected preflight cannot disprove an earlier ambiguous deposit.
      const rejected =
        error instanceof SandboxGatewayError &&
        error.outcome === 'rejected' &&
        claimed.previousStatus !== 'unknown';
      await sql`
        UPDATE natural_sandbox_funding
        SET status=${rejected ? 'FAILED' : 'unknown'},lease_until=NULL,updated_at=${this.clock()}
        WHERE id=${claimed.id}::uuid AND generation=${claimed.generation}
      `.execute(this.db);
    }
  }

  private async getSends(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal) {
    const result = await sql<Send & { recipient_name: string; amount_minor: number }>`
      SELECT s.*, r.recipient_name, r.amount_minor
      FROM natural_sandbox_sends s
      JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
      WHERE s.account_id=${actor.userId}::uuid
      ORDER BY s.created_at DESC LIMIT 20
    `.execute(tx);
    return result.rows;
  }

  async state(actor: AccountPrincipal): Promise<SandboxSendState> {
    await this.db.transaction().execute((tx) => this.authorize(tx, actor));
    await this.reconcile(actor);
    const snapshot = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const connection = await this.connection(tx, actor);
      const [recipients, funding, sends] = await Promise.all([
        this.recipients(tx, actor),
        this.getFunding(tx, actor),
        this.getSends(tx, actor),
      ]);
      return { connection, recipients, funding, sends };
    });
    // A setup snapshot is not a spendable balance. Read the provider for display;
    // a failed read becomes unavailable instead of showing stale test dollars.
    let currentWallets: SandboxWallet[] = [];
    if (snapshot.connection?.status === 'connected' && snapshot.connection.customer_party_id) {
      try {
        // Refresh authority and balance without moving setup back to verifying.
        // Background dashboard polling must not interrupt a reviewed command.
        currentWallets = await this.verifiedSender(snapshot.connection);
      } catch {
        currentWallets = [];
      }
    }
    return {
      available: true,
      connection: snapshot.connection
        ? {
            status:
              snapshot.connection.status === 'connected'
                ? 'ready'
                : snapshot.connection.status === 'blocked'
                  ? 'blocked'
                  : snapshot.connection.status === 'unknown'
                    ? 'unknown'
                    : 'setting_up',
            retryAllowed:
              snapshot.connection.status === 'unknown' &&
              snapshot.connection.updated_at.getTime() > this.clock().getTime() - RETRY_WINDOW_MS,
            balances:
              snapshot.connection.status === 'connected'
                ? snapshot.connection.balances.map((balance) => ({
                    id: balance.id,
                    currency: balance.currency,
                    availableMinor:
                      currentWallets.find(
                        (wallet) =>
                          wallet.id === balance.providerWalletId &&
                          wallet.partyId === snapshot.connection?.customer_party_id &&
                          wallet.status === 'active' &&
                          wallet.walletType === 'standard' &&
                          wallet.balance?.currency === 'USD',
                      )?.balance?.available ?? null,
                  }))
                : [],
          }
        : null,
      recipients: snapshot.recipients.map(({ accountId, name, phoneLast4 }) => ({
        accountId,
        name,
        phoneLast4,
      })),
      funding: snapshot.funding
        ? {
            status: this.fundingStatus(snapshot.funding),
            amountMinor: String(snapshot.funding.amount_minor),
            retryAllowed: this.fundingRetryAllowed(snapshot.funding),
          }
        : null,
      transfers: snapshot.sends.map((send) => ({
        id: send.id,
        reviewId: send.review_id,
        recipientName: send.recipient_name,
        amountMinor: String(send.amount_minor),
        status: send.status,
        createdAt: send.created_at.toISOString(),
      })),
    };
  }

  /** Both the debtor and expense owner may inspect one share, without provider IDs. */
  async shareState(actor: AccountPrincipal, shareId: string): Promise<SandboxShareState> {
    await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      await this.shareBinding(tx, actor, shareId, false);
    });
    await this.reconcileShare(shareId);
    const snapshot = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const binding = await this.shareBinding(tx, actor, shareId, false);
      const latest = await this.latestShareSend(tx, shareId);
      const isDebtor = binding.share.user_id === actor.userId;
      const sender = isDebtor
        ? await this.connection(tx, actor)
        : ((
            await sql<Connection>`
              SELECT * FROM natural_sandbox_send_connections
              WHERE account_id=${binding.share.user_id}::uuid
                AND phone_hash=${binding.share.phone_hash}
            `.execute(tx)
          ).rows[0] ?? null);
      const funding = isDebtor ? await this.getFunding(tx, actor) : null;
      const currentReview = (
        await sql<{ id: string }>`
          SELECT id FROM natural_sandbox_send_reviews
          WHERE share_id=${shareId}::uuid AND status='open' AND expires_at>${this.clock()}
            AND share_attempt_snapshot=${latest?.attempt_sequence ?? '0'}::bigint
          ORDER BY created_at DESC,id DESC LIMIT 1
        `.execute(tx)
      ).rows[0];
      return { binding, latest, isDebtor, sender, funding, currentReview };
    });
    let sourceAvailableMinor: string | null = null;
    let sourceCanCover = false;
    let recipientVerified = false;
    const amount = Number(snapshot.binding.share.amount_minor);
    if (snapshot.isDebtor && snapshot.sender?.status === 'connected') {
      try {
        const wallets = await this.verifiedSender(snapshot.sender);
        const available = wallets
          .filter((wallet) => wallet.balance?.currency === 'USD')
          .map((wallet) => Number(wallet.balance!.available))
          .filter((value) => Number.isSafeInteger(value) && value >= 0);
        if (available.length) {
          const maximum = Math.max(...available);
          sourceAvailableMinor = String(maximum);
          sourceCanCover = maximum >= amount;
        }
      } catch {
        // An unavailable provider read never becomes an assumed spendable balance.
      }
      if (snapshot.binding.recipient) {
        try {
          await this.verifiedRecipient(snapshot.binding.recipient.partyId);
          recipientVerified = true;
        } catch {
          // The review command will expose an actionable recipient/setup error.
        }
      }
    }
    const send = snapshot.latest;
    const effectiveSendStatus =
      send?.status === 'submitting' && (!send.lease_until || send.lease_until <= this.clock())
        ? 'unknown'
        : send && ['FAILED', 'RETURNED'].includes(send.status) && !send.provider_payment_id
          ? 'unknown'
          : send?.status;
    const status: SandboxShareState['status'] =
      snapshot.binding.expense.payment_environment !== 'sandbox'
        ? 'manual'
        : snapshot.binding.share.canceled_at
          ? 'canceled'
          : !send
            ? snapshot.currentReview
              ? 'reviewing'
              : 'unpaid'
            : effectiveSendStatus === 'COMPLETED'
              ? 'paid'
              : effectiveSendStatus === 'RETURNED'
                ? 'returned'
                : effectiveSendStatus === 'unknown'
                  ? 'unknown'
                  : ['FAILED', 'APPROVAL_DENIED', 'CANCELED'].includes(effectiveSendStatus ?? '')
                    ? 'failed'
                    : 'processing';
    return {
      shareId,
      expenseId: snapshot.binding.expense.id,
      amountMinor: snapshot.binding.share.amount_minor,
      status,
      transfer: send
        ? {
            id: send.id,
            reviewId: send.review_id,
            amountMinor: snapshot.binding.share.amount_minor,
            status: effectiveSendStatus!,
            createdAt: send.created_at.toISOString(),
          }
        : null,
      canReview:
        snapshot.isDebtor &&
        snapshot.binding.expense.payment_environment === 'sandbox' &&
        !snapshot.binding.share.canceled_at &&
        Number.isSafeInteger(amount) &&
        amount > 0 &&
        amount <= MAX_TEST_CENTS &&
        (!send || this.shareAttemptReleased(send)) &&
        sourceCanCover &&
        recipientVerified,
      senderSetupRequired: snapshot.sender?.status !== 'connected',
      recipientSetupRequired: !snapshot.binding.recipient,
      sourceAvailableMinor,
      funding: snapshot.funding
        ? {
            status: this.fundingStatus(snapshot.funding),
            amountMinor: String(snapshot.funding.amount_minor),
            retryAllowed: this.fundingRetryAllowed(snapshot.funding),
          }
        : null,
    };
  }

  private async destination(
    tx: Kysely<PaymentDatabase>,
    actor: AccountPrincipal,
    recipientAccountId: string,
  ): Promise<Recipient> {
    const recipient = (await this.recipients(tx, actor)).find(
      (item) => item.accountId === recipientAccountId,
    );
    if (!recipient)
      throw new SandboxSendError('RECIPIENT_CHANGED', 'Choose an available test recipient.', 409);
    return recipient;
  }

  /** Creates a short-lived, server-built review. No payment is submitted here. */
  async review(
    actor: AccountPrincipal,
    input: { recipientAccountId: string; amountMinor: string; note: string },
    requestKey: string,
  ) {
    const amount = cents(input.amountMinor);
    const note = input.note.trim();
    if (note.length > 80)
      throw new SandboxSendError('INVALID_NOTE', 'Keep the note under 80 characters.', 400);
    const prepared = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const connection = await this.connection(tx, actor);
      this.ready(connection);
      const recipient = await this.destination(tx, actor, input.recipientAccountId);
      if (recipient.partyId === connection.customer_party_id)
        throw new SandboxSendError('INVALID_RECIPIENT', 'Choose another test account.', 400);
      const existing = (
        await sql<Review>`
          SELECT * FROM natural_sandbox_send_reviews
          WHERE account_id=${actor.userId}::uuid AND client_request_key=${requestKey}::uuid
        `.execute(tx)
      ).rows[0];
      if (
        existing &&
        (existing.share_id !== null ||
          existing.phone_hash !== actor.phoneHash ||
          existing.sender_connection_id !== connection.id ||
          existing.recipient_party_id !== recipient.partyId ||
          existing.amount_minor !== amount ||
          existing.note !== note)
      )
        throw new SandboxSendError(
          'REVIEW_CHANGED',
          'This review has different details. Start again.',
        );
      return { connection, recipient, existing };
    });
    if (prepared.existing) {
      if (prepared.existing.status !== 'open' || prepared.existing.expires_at <= this.clock())
        throw new SandboxSendError('REVIEW_EXPIRED', 'Review this test payment again.');
      let available: string | null = null;
      try {
        const wallet = await this.gateway.getWallet({
          customerPartyId: prepared.existing.sender_party_id,
          walletId: prepared.existing.sender_wallet_id,
        });
        if (
          wallet.partyId === prepared.existing.sender_party_id &&
          wallet.status === 'active' &&
          wallet.walletType === 'standard' &&
          wallet.balance?.currency === 'USD'
        )
          available = wallet.balance.available;
      } catch {
        // Retain the immutable review, but do not suggest a stale source balance.
      }
      return this.reviewDto(prepared.existing, prepared.connection, available);
    }
    const wallets = await this.verifiedSender(prepared.connection);
    await this.verifiedRecipient(prepared.recipient.partyId);
    const wallet = wallets.find(
      (candidate) =>
        candidate.balance?.currency === 'USD' && Number(candidate.balance.available) >= amount,
    );
    if (!wallet)
      throw new SandboxSendError(
        'INSUFFICIENT_TEST_BALANCE',
        'Add test dollars or choose a smaller amount.',
        409,
      );
    const now = this.clock();
    const reviewId = randomUUID();
    await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const current = await this.connection(tx, actor);
      this.ready(current);
      if (
        current.id !== prepared.connection.id ||
        current.customer_party_id !== prepared.connection.customer_party_id ||
        !current.balances.some((balance) => balance.providerWalletId === wallet.id)
      )
        throw new SandboxSendError('SOURCE_CHANGED', 'Your test wallet changed. Review again.');
      const recipient = await this.destination(tx, actor, input.recipientAccountId);
      if (recipient.partyId !== prepared.recipient.partyId)
        throw new SandboxSendError('RECIPIENT_CHANGED', 'The destination changed. Review again.');
      await sql`
        INSERT INTO natural_sandbox_send_reviews
          (id,account_id,client_request_key,phone_hash,sender_connection_id,sender_party_id,
           sender_wallet_id,recipient_account_id,recipient_party_id,recipient_name,
           recipient_phone_last4,amount_minor,note,status,created_at,expires_at)
        VALUES (
          ${reviewId}::uuid,${actor.userId}::uuid,${requestKey}::uuid,
          ${actor.phoneHash},${current.id}::uuid,
          ${current.customer_party_id},${wallet.id},
          ${recipient.accountId === 'sandbox-fixture' ? null : recipient.accountId}::uuid,
          ${recipient.partyId},${recipient.name},${recipient.phoneLast4},
          ${amount},${note},'open',${now},${new Date(now.getTime() + REVIEW_TTL_MS)}
        ) ON CONFLICT (account_id,client_request_key) DO NOTHING
      `.execute(tx);
    });
    const saved = (
      await sql<Review>`
        SELECT * FROM natural_sandbox_send_reviews
        WHERE account_id=${actor.userId}::uuid AND client_request_key=${requestKey}::uuid
      `.execute(this.db)
    ).rows[0];
    if (
      !saved ||
      saved.phone_hash !== actor.phoneHash ||
      saved.sender_connection_id !== prepared.connection.id ||
      saved.sender_wallet_id !== wallet.id ||
      saved.recipient_party_id !== prepared.recipient.partyId ||
      saved.amount_minor !== amount ||
      saved.note !== note
    )
      throw new SandboxSendError('REVIEW_CHANGED', 'This review changed. Start again.');
    return this.reviewDto(saved, prepared.connection, wallet.balance?.available ?? null);
  }

  /** A share chooses its own amount and creditor; the browser supplies only its ID. */
  async reviewShare(actor: AccountPrincipal, input: { shareId: string }, requestKey: string) {
    const prepared = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const binding = await this.shareBinding(tx, actor, input.shareId, true);
      const recipient = this.assertPayableShare(binding, actor);
      const latest = await this.assertShareAvailable(tx, input.shareId);
      const connection = await this.connection(tx, actor);
      this.ready(connection);
      if (recipient.partyId === connection.customer_party_id)
        throw new SandboxSendError('INVALID_RECIPIENT', 'Choose another test account.', 400);
      const note = this.shareNote(binding.expense);
      const existing = (
        await sql<Review>`
          SELECT * FROM natural_sandbox_send_reviews
          WHERE account_id=${actor.userId}::uuid AND client_request_key=${requestKey}::uuid
        `.execute(tx)
      ).rows[0];
      if (
        existing &&
        (existing.share_id !== input.shareId ||
          existing.phone_hash !== actor.phoneHash ||
          existing.sender_connection_id !== connection.id ||
          existing.sender_party_id !== connection.customer_party_id ||
          existing.recipient_account_id !== recipient.accountId ||
          existing.recipient_party_id !== recipient.partyId ||
          existing.amount_minor !== Number(binding.share.amount_minor) ||
          existing.note !== note ||
          existing.share_attempt_snapshot !== (latest?.attempt_sequence ?? '0'))
      )
        throw new SandboxSendError(
          'REVIEW_CHANGED',
          'This review has different details. Start again.',
        );
      return { binding, connection, recipient, latest, note, existing };
    });
    if (prepared.existing) {
      if (prepared.existing.status !== 'open' || prepared.existing.expires_at <= this.clock())
        throw new SandboxSendError('REVIEW_EXPIRED', 'Review this test payment again.');
      let available: string | null = null;
      try {
        const wallet = await this.gateway.getWallet({
          customerPartyId: prepared.existing.sender_party_id,
          walletId: prepared.existing.sender_wallet_id,
        });
        if (
          wallet.partyId === prepared.existing.sender_party_id &&
          wallet.status === 'active' &&
          wallet.walletType === 'standard' &&
          wallet.balance?.currency === 'USD'
        )
          available = wallet.balance.available;
      } catch {
        // The original review remains immutable; an unavailable balance stays unknown.
      }
      return this.reviewDto(prepared.existing, prepared.connection, available);
    }
    const wallets = await this.verifiedSender(prepared.connection);
    await this.verifiedRecipient(prepared.recipient.partyId);
    const amount = Number(prepared.binding.share.amount_minor);
    const wallet = wallets.find(
      (candidate) =>
        candidate.balance?.currency === 'USD' && Number(candidate.balance.available) >= amount,
    );
    if (!wallet)
      throw new SandboxSendError(
        'INSUFFICIENT_TEST_BALANCE',
        'Add test dollars before reviewing this share.',
        409,
      );
    const reviewId = randomUUID();
    const now = this.clock();
    await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const binding = await this.shareBinding(tx, actor, input.shareId, true);
      const recipient = this.assertPayableShare(binding, actor);
      const latest = await this.assertShareAvailable(tx, input.shareId);
      const connection = await this.connection(tx, actor);
      this.ready(connection);
      if (
        binding.expense.id !== prepared.binding.expense.id ||
        binding.share.amount_minor !== prepared.binding.share.amount_minor ||
        recipient.accountId !== prepared.recipient.accountId ||
        recipient.partyId !== prepared.recipient.partyId ||
        connection.id !== prepared.connection.id ||
        connection.customer_party_id !== prepared.connection.customer_party_id ||
        !connection.balances.some((balance) => balance.providerWalletId === wallet.id) ||
        (latest?.attempt_sequence ?? '0') !== (prepared.latest?.attempt_sequence ?? '0')
      )
        throw new SandboxSendError('REVIEW_CHANGED', 'This share changed. Review again.');
      await sql`
        INSERT INTO natural_sandbox_send_reviews
          (id,account_id,client_request_key,share_id,share_attempt_snapshot,
           phone_hash,sender_connection_id,sender_party_id,sender_wallet_id,
           recipient_account_id,recipient_party_id,recipient_name,recipient_phone_last4,
           amount_minor,note,status,created_at,expires_at)
        VALUES (
          ${reviewId}::uuid,${actor.userId}::uuid,${requestKey}::uuid,
          ${input.shareId}::uuid,${latest?.attempt_sequence ?? '0'}::bigint,
          ${actor.phoneHash},${connection.id}::uuid,${connection.customer_party_id},
          ${wallet.id},${recipient.accountId}::uuid,${recipient.partyId},
          ${recipient.name},${recipient.phoneLast4},${amount},${prepared.note},
          'open',${now},${new Date(now.getTime() + REVIEW_TTL_MS)}
        ) ON CONFLICT (account_id,client_request_key) DO NOTHING
      `.execute(tx);
    });
    const saved = (
      await sql<Review>`
        SELECT * FROM natural_sandbox_send_reviews
        WHERE account_id=${actor.userId}::uuid AND client_request_key=${requestKey}::uuid
      `.execute(this.db)
    ).rows[0];
    if (
      !saved ||
      saved.share_id !== input.shareId ||
      saved.phone_hash !== actor.phoneHash ||
      saved.sender_connection_id !== prepared.connection.id ||
      saved.sender_wallet_id !== wallet.id ||
      saved.recipient_account_id !== prepared.recipient.accountId ||
      saved.recipient_party_id !== prepared.recipient.partyId ||
      saved.amount_minor !== amount ||
      saved.note !== prepared.note ||
      saved.share_attempt_snapshot !== (prepared.latest?.attempt_sequence ?? '0') ||
      saved.status !== 'open' ||
      saved.expires_at <= this.clock()
    )
      throw new SandboxSendError('REVIEW_CHANGED', 'This review changed. Start again.');
    return this.reviewDto(saved, prepared.connection, wallet.balance?.available ?? null);
  }

  private reviewDto(review: Review, connection: Connection, available?: string | null) {
    return {
      review: {
        id: review.id,
        shareId: review.share_id,
        recipientName: review.recipient_name,
        phoneLast4: review.recipient_phone_last4,
        amountMinor: String(review.amount_minor),
        note: review.note,
        sourceWalletId:
          connection.balances.find(
            (balance) => balance.providerWalletId === review.sender_wallet_id,
          )?.id ?? '',
        sourceAvailableMinor: available ?? null,
      },
    };
  }

  private async savePayment(
    send: Send,
    review: Pick<Review, 'sender_party_id' | 'recipient_party_id' | 'amount_minor'>,
    payment: SandboxPayment,
  ) {
    await saveSandboxPaymentObservation(
      this.db,
      {
        id: send.id,
        operation_id: send.operation_id,
        sender_party_id: review.sender_party_id,
        recipient_party_id: review.recipient_party_id,
        amount_minor: review.amount_minor,
      },
      payment,
      this.agentId,
      this.clock(),
    );
  }

  /** Exact review confirmation inserts the immutable operation before any provider call. */
  async confirm(actor: AccountPrincipal, reviewId: string, expectedShareId?: string) {
    const claimed = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      // Discover the expense without holding a review lock. Share-linked actions
      // lock expense → share → review, matching social cancellation's order.
      const preview = (
        await sql<Pick<Review, 'share_id'>>`
          SELECT share_id FROM natural_sandbox_send_reviews
          WHERE id=${reviewId}::uuid AND account_id=${actor.userId}::uuid
        `.execute(tx)
      ).rows[0];
      if (!preview || (expectedShareId && preview.share_id !== expectedShareId))
        throw new SandboxSendError('REVIEW_NOT_FOUND', 'This review is unavailable.', 404);
      const binding = preview.share_id
        ? await this.shareBinding(tx, actor, preview.share_id, true)
        : null;
      const result = await sql<Review>`
        SELECT * FROM natural_sandbox_send_reviews
        WHERE id=${reviewId}::uuid AND account_id=${actor.userId}::uuid FOR UPDATE
      `.execute(tx);
      const review = result.rows[0];
      if (!review || review.phone_hash !== actor.phoneHash || review.share_id !== preview.share_id)
        throw new SandboxSendError('REVIEW_NOT_FOUND', 'This review is unavailable.', 404);
      const connection = await this.connection(tx, actor);
      this.ready(connection);
      if (
        connection.id !== review.sender_connection_id ||
        connection.customer_party_id !== review.sender_party_id ||
        !connection.balances.some((balance) => balance.providerWalletId === review.sender_wallet_id)
      )
        throw new SandboxSendError('SOURCE_CHANGED', 'Your test wallet changed. Review again.');
      const recipient = binding
        ? this.assertPayableShare(binding, actor)
        : await this.destination(tx, actor, review.recipient_account_id ?? 'sandbox-fixture');
      if (
        recipient.partyId !== review.recipient_party_id ||
        (binding &&
          (recipient.accountId !== review.recipient_account_id ||
            review.amount_minor !== Number(binding.share.amount_minor) ||
            review.note !== this.shareNote(binding.expense)))
      )
        throw new SandboxSendError('RECIPIENT_CHANGED', 'The destination changed. Review again.');
      let existing = (
        await sql<Send>`SELECT * FROM natural_sandbox_sends WHERE review_id=${review.id}::uuid FOR UPDATE`.execute(
          tx,
        )
      ).rows[0];
      if (!existing) {
        if (review.status !== 'open' || review.expires_at <= this.clock())
          throw new SandboxSendError('REVIEW_EXPIRED', 'Review this test payment again.');
        if (binding) {
          const latest = await this.assertShareAvailable(tx, binding.share.id);
          if (review.share_attempt_snapshot !== (latest?.attempt_sequence ?? '0'))
            throw new SandboxSendError(
              'REVIEW_EXPIRED',
              'Review this share again before another payment.',
            );
        }
        const now = this.clock();
        const id = randomUUID();
        existing = (
          await sql<Send>`
            INSERT INTO natural_sandbox_sends
              (id,review_id,share_id,account_id,operation_id,idempotency_key,status,
               first_submission_at,lease_until,generation,created_at,updated_at)
            VALUES (${id}::uuid,${review.id}::uuid,${review.share_id}::uuid,${actor.userId}::uuid,
                    ${randomUUID()}::uuid,${randomUUID()}::uuid,'prepared',
                    NULL,NULL,0,${now},${now}) RETURNING *
          `.execute(tx)
        ).rows[0]!;
        await sql`
          UPDATE natural_sandbox_send_reviews
          SET status='confirmed',confirmed_at=${now} WHERE id=${review.id}::uuid
        `.execute(tx);
      }
      if (existing.status !== 'prepared') return { review, send: existing, drive: false };
      if (!(await paymentSubmissionsAllowed(tx, 'sandbox')))
        throw new SandboxSendError('PAYMENTS_PAUSED', 'Test payments are temporarily paused.', 503);
      const now = this.clock();
      const updated = (
        await sql<Send>`
          UPDATE natural_sandbox_sends
          SET status='submitting', first_submission_at=COALESCE(first_submission_at,${now}),
              lease_until=${new Date(now.getTime() + 30_000)},
              generation=generation+1,updated_at=${now}
          WHERE id=${existing.id}::uuid RETURNING *
        `.execute(tx)
      ).rows[0]!;
      return { review, send: updated, drive: true };
    });
    if (claimed.drive) {
      let submitted = false;
      try {
        const sender = await this.gateway.getCustomer(claimed.review.sender_party_id);
        if (
          sender.delegation.status !== 'ACTIVE' ||
          !permitted(sender.delegation.permissions, SEND_PERMISSIONS) ||
          !sender.agents.some(
            (agent) =>
              agent.id === this.agentId &&
              agent.status === 'ACTIVE' &&
              permitted(agent.permissions, SEND_PERMISSIONS),
          )
        )
          throw new SandboxSendError('TEST_ACCESS_CHANGED', 'Test payment access changed.');
        await this.verifiedRecipient(claimed.review.recipient_party_id);
        const wallet = await this.gateway.getWallet({
          customerPartyId: claimed.review.sender_party_id,
          walletId: claimed.review.sender_wallet_id,
        });
        if (
          wallet.partyId !== claimed.review.sender_party_id ||
          wallet.status !== 'active' ||
          wallet.walletType !== 'standard' ||
          wallet.balance?.currency !== 'USD' ||
          Number(wallet.balance.available) < claimed.review.amount_minor
        )
          throw new SandboxSendError('INSUFFICIENT_TEST_BALANCE', 'Test balance changed.');
        submitted = true;
        const payment = await this.gateway.send({
          senderPartyId: claimed.review.sender_party_id,
          walletId: claimed.review.sender_wallet_id,
          recipientPartyId: claimed.review.recipient_party_id,
          amount: claimed.review.amount_minor,
          description: claimed.review.note,
          operationId: claimed.send.operation_id,
          idempotencyKey: claimed.send.idempotency_key,
        });
        await this.savePayment(claimed.send, claimed.review, payment);
      } catch (error) {
        const definitive =
          (!submitted && error instanceof SandboxSendError) ||
          (error instanceof SandboxGatewayError && error.outcome === 'rejected');
        await sql`
          UPDATE natural_sandbox_sends SET status=${definitive ? 'FAILED' : 'unknown'},
              lease_until=NULL,updated_at=${this.clock()}
          WHERE id=${claimed.send.id}::uuid AND status='submitting'
        `.execute(this.db);
      }
    }
    const result = await sql<Send>`
      SELECT * FROM natural_sandbox_sends WHERE id=${claimed.send.id}::uuid
    `.execute(this.db);
    const send = result.rows[0]!;
    return {
      transfer: {
        id: send.id,
        reviewId: send.review_id,
        shareId: send.share_id,
        recipientName: claimed.review.recipient_name,
        amountMinor: String(claimed.review.amount_minor),
        status: send.status,
        createdAt: send.created_at.toISOString(),
      },
    };
  }

  /** URL-bound confirmation cannot dispatch an unrelated or direct-send review. */
  confirmShare(actor: AccountPrincipal, input: { shareId: string; reviewId: string }) {
    return this.confirm(actor, input.reviewId, input.shareId);
  }

  private async reconcile(actor: AccountPrincipal) {
    const result = await sql<ReconcileRow>`
      SELECT s.*,r.sender_party_id,r.recipient_party_id,r.amount_minor,r.note,
             r.sender_wallet_id,r.sender_connection_id,r.recipient_account_id,
             r.recipient_name,r.recipient_phone_last4,r.phone_hash,r.expires_at
      FROM natural_sandbox_sends s JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
      WHERE s.account_id=${actor.userId}::uuid AND r.phone_hash=${actor.phoneHash}
        AND (s.status IN ('unknown','submitting','CREATED','PROCESSING','IN_REVIEW','COMPLETED')
             OR s.provider_payment_id IS NOT NULL)
      ORDER BY CASE WHEN s.status IN ('unknown','submitting') THEN 0 ELSE 1 END,
               s.updated_at ASC LIMIT 5
    `.execute(this.db);
    await this.reconcileRows(result.rows);
  }

  private async reconcileShare(shareId: string) {
    const result = await sql<ReconcileRow>`
      SELECT s.*,r.sender_party_id,r.recipient_party_id,r.amount_minor,r.note,
             r.sender_wallet_id,r.sender_connection_id,r.recipient_account_id,
             r.recipient_name,r.recipient_phone_last4,r.phone_hash,r.expires_at
      FROM natural_sandbox_sends s JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
      WHERE s.share_id=${shareId}::uuid
        AND (s.status IN ('unknown','submitting','CREATED','PROCESSING','IN_REVIEW','COMPLETED')
             OR s.provider_payment_id IS NOT NULL)
      ORDER BY s.attempt_sequence DESC LIMIT 5
    `.execute(this.db);
    await this.reconcileRows(result.rows);
  }

  private async reconcileRows(rows: ReconcileRow[]) {
    for (const row of rows) {
      try {
        let payment: SandboxPayment | undefined;
        if (row.provider_payment_id) {
          payment = await this.gateway.getPayment({
            senderPartyId: row.sender_party_id,
            recipientPartyId: row.recipient_party_id,
            amount: row.amount_minor,
            paymentId: row.provider_payment_id,
          });
        } else if (row.status === 'unknown' || row.status === 'submitting') {
          let cursor: string | undefined;
          for (let page = 0; page < 3; page++) {
            const batch = await this.gateway.listPayments({
              senderPartyId: row.sender_party_id,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            payment = batch.payments.find(
              (item) => item.tags.app_operation_id === row.operation_id,
            );
            if (payment || !batch.hasMore || !batch.nextCursor) break;
            cursor = batch.nextCursor;
          }
        }
        if (payment) await this.savePayment(row, row, payment);
        else if (
          row.status === 'submitting' &&
          (!row.lease_until || row.lease_until <= this.clock())
        )
          await sql`
            UPDATE natural_sandbox_sends SET status='unknown',updated_at=${this.clock()}
            WHERE id=${row.id}::uuid AND status='submitting'
          `.execute(this.db);
        else if (!payment && row.status === 'unknown')
          await sql`
            UPDATE natural_sandbox_sends SET updated_at=${this.clock()}
            WHERE id=${row.id}::uuid AND status='unknown'
          `.execute(this.db);
      } catch {
        // A failed read never changes the saved payment result or triggers a second send.
      }
    }
  }
}
