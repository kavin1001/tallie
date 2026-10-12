import { randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '@tallie/identity';
import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';
import type { OwnerPilotPayment, OwnerPilotState } from './owner-pilot-contracts';

export interface OwnerPilotGateway {
  /** The web gateway also verifies primaryPhone against the account's verified phone. */
  getOwnerWallet(): Promise<{
    partyId: string;
    partyType: 'PERSON';
    status: 'ACTIVE';
    handle: string | null;
    primaryPhone: string | null;
    walletId: string;
    availableMinor: number;
    currency: 'USD';
  }>;
  send(input: {
    walletId: string;
    recipientHandle: string;
    amountMinor: number;
    operationId: string;
    idempotencyKey: string;
  }): Promise<OwnerPilotPayment>;
  getPayment(id: string): Promise<OwnerPilotPayment>;
  findPayment(operationId: string): Promise<OwnerPilotPayment | null>;
}

export interface OwnerPilotConfiguration {
  enabled: boolean;
  ownerAccountId: string;
  ownerPhoneHash: string;
  platformPartyId: string;
  agentId: string;
  walletId: string;
  recipientHandle: string;
  maxAmountMinor?: number;
}

const RECENT_MS = 10 * 60_000;
const UNKNOWN_AFTER_MS = 30_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerId = (prefix: string, value: string) =>
  new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value);
const statuses = new Set([
  'CREATED',
  'PROCESSING',
  'PENDING_CLAIM',
  'IN_REVIEW',
  'COMPLETED',
  'FAILED',
  'RETURNED',
  'APPROVAL_DENIED',
  'CANCELED',
]);

type Review = {
  id: string;
  account_id: string;
  phone_hash: string;
  platform_party_id: string;
  agent_id: string;
  wallet_id: string;
  recipient_handle: string;
  amount_minor: number;
  status: 'open' | 'confirmed' | 'expired';
  created_at: Date;
  expires_at: Date;
};
type Send = {
  id: string;
  account_id: string;
  platform_party_id: string;
  review_id: string;
  operation_id: string;
  idempotency_key: string;
  provider_payment_id: string | null;
  recipient_party_id: string | null;
  recipient_agent_id: string | null;
  status: string;
  fee_minor: number | null;
  attention: string | null;
  first_submission_at: Date;
  created_at: Date;
  updated_at: Date;
};

export class OwnerPilotError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'OwnerPilotError';
  }
}

/**
 * Explicit local owner pilot. Its enable switch permits only one operation of at
 * most USD 1 for the fixed owner, source and handle. It does not resume the global
 * production submission control, authorize customer spending or pay social shares.
 * No method can submit an existing operation again, even after a terminal failure.
 */
export class OwnerPilotService {
  private readonly config: Readonly<Required<OwnerPilotConfiguration>>;

  constructor(
    private readonly db: Kysely<PaymentDatabase>,
    private readonly gateway: OwnerPilotGateway,
    config: OwnerPilotConfiguration,
    private readonly clock = () => new Date(),
  ) {
    const amount = config.maxAmountMinor ?? 100;
    if (
      typeof config.enabled !== 'boolean' ||
      !uuid.test(config.ownerAccountId) ||
      !/^[0-9a-f]{64}$/i.test(config.ownerPhoneHash) ||
      !providerId('pty', config.platformPartyId) ||
      !providerId('agt', config.agentId) ||
      !providerId('wal', config.walletId) ||
      !/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(config.recipientHandle) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 100
    )
      throw new Error('Owner pilot configuration is invalid.');
    this.config = Object.freeze({ ...config, maxAmountMinor: amount });
  }

  private enabled() {
    if (!this.config.enabled) throw new OwnerPilotError('OWNER_PILOT_DISABLED', 503);
  }

  private async authorize(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal, recent = false) {
    if (
      actor.userId !== this.config.ownerAccountId ||
      actor.phoneHash !== this.config.ownerPhoneHash ||
      !uuid.test(actor.sessionId)
    )
      throw new OwnerPilotError('OWNER_PILOT_NOT_AUTHORIZED', 403);
    const now = this.clock();
    const result = await sql<{ id: string }>`
      SELECT s.id FROM auth_session s
      JOIN auth_user u ON u.id=s.user_id
      JOIN identity_phone_bindings p ON p.user_id=u.id
      WHERE s.id=${actor.sessionId}::uuid AND s.user_id=${actor.userId}::uuid
        AND s.expires_at>${now} AND s.assurance_kind='passkey' AND NOT u.phone_demo
        AND s.assurance_at<=${now} AND p.phone_hash=${actor.phoneHash}
        AND p.verified_at<=${now}
        AND EXISTS(SELECT 1 FROM auth_passkey k WHERE k.user_id=u.id)
        AND (NOT ${recent} OR s.assurance_at>=${new Date(now.getTime() - RECENT_MS)})
      FOR SHARE OF s,u,p
    `.execute(tx);
    if (!result.rows.length) throw new OwnerPilotError('OWNER_PILOT_PASSKEY_REQUIRED', 401);
  }

  private compatible(review: Review) {
    if (
      review.account_id !== this.config.ownerAccountId ||
      review.phone_hash !== this.config.ownerPhoneHash ||
      review.platform_party_id !== this.config.platformPartyId ||
      review.agent_id !== this.config.agentId ||
      review.wallet_id !== this.config.walletId ||
      review.recipient_handle !== this.config.recipientHandle ||
      review.amount_minor !== this.config.maxAmountMinor
    )
      throw new OwnerPilotError('OWNER_PILOT_BINDING_CHANGED');
  }

  private async wallet(requireFunds: boolean) {
    const wallet = await this.gateway.getOwnerWallet();
    if (
      wallet.partyId !== this.config.platformPartyId ||
      wallet.partyType !== 'PERSON' ||
      wallet.status !== 'ACTIVE' ||
      wallet.walletId !== this.config.walletId ||
      wallet.currency !== 'USD' ||
      !Number.isSafeInteger(wallet.availableMinor) ||
      wallet.availableMinor < 0 ||
      wallet.handle?.replace(/^@/, '').toLowerCase() ===
        this.config.recipientHandle.replace(/^@/, '').toLowerCase()
    )
      throw new OwnerPilotError('OWNER_PILOT_WALLET_CHANGED');
    if (requireFunds && wallet.availableMinor < this.config.maxAmountMinor)
      throw new OwnerPilotError('OWNER_PILOT_INSUFFICIENT_BALANCE');
    return wallet;
  }

  private async saved(tx: Kysely<PaymentDatabase>) {
    const send = (
      await sql<Send>`SELECT * FROM natural_owner_pilot_sends
      WHERE account_id=${this.config.ownerAccountId}::uuid
        OR platform_party_id=${this.config.platformPartyId}`.execute(tx)
    ).rows[0];
    if (send && send.account_id !== this.config.ownerAccountId)
      throw new OwnerPilotError('OWNER_PILOT_ALREADY_USED');
    const review = (
      await sql<Review>`SELECT * FROM natural_owner_pilot_reviews
      WHERE account_id=${this.config.ownerAccountId}::uuid
      AND (${send?.review_id ?? null}::uuid IS NULL OR id=${send?.review_id ?? null}::uuid)
      ORDER BY created_at DESC,id DESC LIMIT 1`.execute(tx)
    ).rows[0];
    if (review) this.compatible(review);
    return { review, send };
  }

  private dto(review: Review | undefined, send: Send | undefined, available: number | null) {
    return {
      available: this.config.enabled,
      recipientHandle: this.config.recipientHandle,
      amountMinor: this.config.maxAmountMinor,
      currency: 'USD',
      availableMinor: available,
      review:
        review && !send && review.status === 'open' && review.expires_at > this.clock()
          ? {
              id: review.id,
              recipientHandle: review.recipient_handle,
              amountMinor: review.amount_minor,
              currency: 'USD',
              expiresAt: review.expires_at.toISOString(),
            }
          : null,
      transfer: send
        ? {
            id: send.id,
            status: send.status,
            recipientHandle: review!.recipient_handle,
            amountMinor: review!.amount_minor,
            currency: 'USD',
            feeMinor: send.fee_minor,
            needsStatusCheck: send.attention !== null,
            createdAt: send.created_at.toISOString(),
            updatedAt: send.updated_at.toISOString(),
          }
        : null,
    } satisfies OwnerPilotState;
  }

  async state(actor: AccountPrincipal): Promise<OwnerPilotState> {
    await this.db.transaction().execute((tx) => this.authorize(tx, actor));
    let available: number | null = null;
    try {
      available = (await this.wallet(false)).availableMinor;
    } catch {
      // A failed canonical read must never replay a cached spendable balance.
    }
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const { review, send } = await this.saved(tx);
      return this.dto(review, send, available);
    });
  }

  /** One immutable review; no request from the browser can alter the payment tuple. */
  async review(actor: AccountPrincipal): Promise<OwnerPilotState> {
    this.enabled();
    await this.db.transaction().execute((tx) => this.authorize(tx, actor, true));
    const wallet = await this.wallet(true);
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, true);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`owner-pilot:${this.config.platformPartyId}`},0))`.execute(
        tx,
      );
      const saved = await this.saved(tx);
      if (saved.send) return this.dto(saved.review, saved.send, wallet.availableMinor);
      if (saved.review?.status === 'open' && saved.review.expires_at > this.clock())
        return this.dto(saved.review, undefined, wallet.availableMinor);
      await sql`UPDATE natural_owner_pilot_reviews SET status='expired'
        WHERE account_id=${actor.userId}::uuid AND status='open'`.execute(tx);
      const now = this.clock();
      const review = (
        await sql<Review>`INSERT INTO natural_owner_pilot_reviews
          (id,account_id,phone_hash,platform_party_id,agent_id,wallet_id,recipient_handle,
           amount_minor,status,created_at,expires_at)
          VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,${actor.phoneHash},
            ${this.config.platformPartyId},${this.config.agentId},${this.config.walletId},
            ${this.config.recipientHandle},${this.config.maxAmountMinor},'open',${now},
            ${new Date(now.getTime() + RECENT_MS)}) RETURNING *`.execute(tx)
      ).rows[0]!;
      return this.dto(review, undefined, wallet.availableMinor);
    });
  }

  async confirm(actor: AccountPrincipal, reviewId: string): Promise<OwnerPilotState> {
    this.enabled();
    if (!uuid.test(reviewId)) throw new OwnerPilotError('OWNER_PILOT_REVIEW_NOT_FOUND', 404);
    const prior = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, true);
      const saved = await this.saved(tx);
      if (!saved.review || saved.review.id !== reviewId)
        throw new OwnerPilotError('OWNER_PILOT_REVIEW_NOT_FOUND', 404);
      return saved;
    });
    // The saved operation is authoritative even if wallet access later disappears.
    if (prior.send) return this.dto(prior.review, prior.send, null);
    const wallet = await this.wallet(true);
    const claimed = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, true);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`owner-pilot:${this.config.platformPartyId}`},0))`.execute(
        tx,
      );
      const saved = await this.saved(tx);
      const review = saved.review;
      if (!review || review.id !== reviewId)
        throw new OwnerPilotError('OWNER_PILOT_REVIEW_NOT_FOUND', 404);
      if (saved.send) return { review, send: saved.send, dispatch: false };
      if (review.status !== 'open' || review.expires_at <= this.clock())
        throw new OwnerPilotError('OWNER_PILOT_REVIEW_EXPIRED');
      const now = this.clock();
      const send = (
        await sql<Send>`INSERT INTO natural_owner_pilot_sends
          (id,account_id,platform_party_id,review_id,operation_id,idempotency_key,status,
           first_submission_at,created_at,updated_at)
          VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,${this.config.platformPartyId},${review.id}::uuid,
            ${randomUUID()}::uuid,${randomUUID()}::uuid,'submitting',${now},${now},${now})
          RETURNING *`.execute(tx)
      ).rows[0]!;
      await sql`UPDATE natural_owner_pilot_reviews SET status='confirmed',confirmed_at=${now}
        WHERE id=${review.id}::uuid`.execute(tx);
      return { review, send, dispatch: true };
    });
    if (claimed.dispatch) {
      try {
        const payment = await this.gateway.send({
          walletId: claimed.review.wallet_id,
          recipientHandle: claimed.review.recipient_handle,
          amountMinor: claimed.review.amount_minor,
          operationId: claimed.send.operation_id,
          idempotencyKey: claimed.send.idempotency_key,
        });
        await this.observe(claimed.send.id, claimed.review, payment);
      } catch (error) {
        // The one-shot reservation remains consumed regardless of error class.
        // Never claim a network/validation failure proves that funds did not move.
        await sql`UPDATE natural_owner_pilot_sends SET
          status=CASE WHEN status='submitting' THEN 'unknown' ELSE status END,
          attention=${error instanceof OwnerPilotError ? 'binding_mismatch' : 'provider_unavailable'},
          updated_at=${this.clock()} WHERE id=${claimed.send.id}::uuid`.execute(this.db);
      }
    }
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const saved = await this.saved(tx);
      // Submission may have changed the available balance. The preflight is stale.
      return this.dto(saved.review, saved.send, claimed.dispatch ? null : wallet.availableMinor);
    });
  }

  private async observe(sendId: string, review: Review, payment: OwnerPilotPayment) {
    if (
      !providerId('pay', payment.id) ||
      !statuses.has(payment.status) ||
      payment.senderPartyId !== review.platform_party_id ||
      payment.senderAgentId !== review.agent_id ||
      payment.amountMinor !== review.amount_minor ||
      payment.currency !== 'USD' ||
      payment.tags.tallie_owner_pilot !== 'v1' ||
      payment.tags.recipient_handle !== review.recipient_handle ||
      payment.recipientPartyId === review.platform_party_id ||
      (payment.recipientPartyId !== null && !providerId('pty', payment.recipientPartyId)) ||
      (payment.recipientAgentId !== null && !providerId('agt', payment.recipientAgentId)) ||
      (payment.feeMinor !== null &&
        (!Number.isSafeInteger(payment.feeMinor) ||
          payment.feeMinor < 0 ||
          payment.feeMinor > 2147483647))
    )
      throw new OwnerPilotError('OWNER_PILOT_OBSERVATION_MISMATCH');
    await this.db.transaction().execute(async (tx) => {
      const send = (
        await sql<Send>`SELECT * FROM natural_owner_pilot_sends
          WHERE id=${sendId}::uuid FOR UPDATE`.execute(tx)
      ).rows[0];
      if (
        !send ||
        send.platform_party_id !== review.platform_party_id ||
        send.review_id !== review.id ||
        payment.tags.app_operation_id !== send.operation_id ||
        (send.provider_payment_id !== null && send.provider_payment_id !== payment.id) ||
        (send.recipient_party_id !== null &&
          send.recipient_party_id !== payment.recipientPartyId) ||
        (send.recipient_agent_id !== null && send.recipient_agent_id !== payment.recipientAgentId)
      )
        throw new OwnerPilotError('OWNER_PILOT_OBSERVATION_MISMATCH');
      await sql`UPDATE natural_owner_pilot_sends SET provider_payment_id=${payment.id},
        recipient_party_id=COALESCE(recipient_party_id,${payment.recipientPartyId}),
        recipient_agent_id=COALESCE(recipient_agent_id,${payment.recipientAgentId}),
        status=CASE
          WHEN status IN ('RETURNED','FAILED','APPROVAL_DENIED','CANCELED') THEN status
          WHEN status='COMPLETED' AND ${payment.status}<>'RETURNED' THEN status
          WHEN status IN ('PROCESSING','IN_REVIEW','PENDING_CLAIM') AND ${payment.status}='CREATED' THEN status
          ELSE ${payment.status} END,
        fee_minor=COALESCE(${payment.feeMinor},fee_minor),attention=NULL,updated_at=${this.clock()}
        WHERE id=${sendId}::uuid`.execute(tx);
    });
  }

  /** Bounded canonical reads of the sole saved operation, safe after process restart. */
  async reconcile(): Promise<void> {
    const { review, send } = await this.saved(this.db);
    if (!send || !review) return;
    try {
      const payment = send.provider_payment_id
        ? await this.gateway.getPayment(send.provider_payment_id)
        : await this.gateway.findPayment(send.operation_id);
      if (payment) await this.observe(send.id, review, payment);
      else
        await sql`UPDATE natural_owner_pilot_sends SET
          status=CASE WHEN status='submitting' AND first_submission_at<=${new Date(this.clock().getTime() - UNKNOWN_AFTER_MS)}
            THEN 'unknown' ELSE status END,
          attention='unresolved_operation',updated_at=${this.clock()}
          WHERE id=${send.id}::uuid AND provider_payment_id IS NULL`.execute(this.db);
    } catch (error) {
      await sql`UPDATE natural_owner_pilot_sends SET
        status=CASE WHEN status='submitting' AND first_submission_at<=${new Date(this.clock().getTime() - UNKNOWN_AFTER_MS)}
          THEN 'unknown' ELSE status END,
        attention=${error instanceof OwnerPilotError ? 'binding_mismatch' : 'provider_unavailable'},
        updated_at=${this.clock()} WHERE id=${send.id}::uuid`.execute(this.db);
    }
  }

  async refresh(actor: AccountPrincipal): Promise<OwnerPilotState> {
    await this.db.transaction().execute((tx) => this.authorize(tx, actor));
    await this.reconcile();
    return this.state(actor);
  }
}
