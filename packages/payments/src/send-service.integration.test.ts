import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountPrincipal } from '@tallie/identity';
import { createDatabase } from '@tallie/db';
import { migrate } from '../../db/src/migrate';
import { SandboxGatewayError } from './gateway';
import {
  setPaymentSubmissionsPaused,
  recordPaymentWorkerHeartbeat,
  paymentWorkerHealth,
  paymentSubmissionsAllowed,
} from './operations';
import type { PaymentDatabase } from './schema';
import { SandboxSendService, type SandboxPayment, type SandboxSendGateway } from './send-service';

config({ quiet: true });
const agentId = 'agt_tallie';
const platformPartyId = 'pty_platform';
const readPermissions = ['party.read', 'wallets.read', 'wallets.balance'];
const sendPermissions = [...readPermissions, 'payments.read', 'payments.create'];

type Fixture = {
  sender: AccountPrincipal;
  recipient: AccountPrincipal;
  senderPartyId: string;
  recipientPartyId: string;
  senderWalletId: string;
  gateway: SandboxSendGateway;
  service: SandboxSendService;
  payment: (input: Parameters<SandboxSendGateway['send']>[0], status?: string) => SandboxPayment;
};

describe('sandbox direct send journal and exact approval', () => {
  const schema = `tallie_send_journal_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = new Date('2026-09-26T12:00:00.000Z');

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error('Local PostgreSQL is required.');
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Tests require local PostgreSQL.');
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString()) as unknown as Kysely<PaymentDatabase>;
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    now = new Date('2026-09-26T12:00:00.000Z');
  });

  async function account(): Promise<AccountPrincipal> {
    const actor = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      phoneHash: randomUUID(),
      displayName: 'Test person',
    };
    await sql`INSERT INTO auth_user(id,name,email) VALUES(${actor.userId}::uuid,${actor.displayName},${`${actor.userId}@test.invalid`})`.execute(
      db,
    );
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at) VALUES(${actor.userId}::uuid,${actor.phoneHash},'test-ciphertext','••• 0000',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,${randomUUID()},${new Date(now.getTime() + 86400_000)},'passkey',${now})`.execute(
      db,
    );
    return actor;
  }

  async function connection(
    table: 'natural_sandbox_connections' | 'natural_sandbox_send_connections',
    actor: AccountPrincipal,
    partyId: string,
    walletId: string,
    permissions: string[],
  ) {
    const id = randomUUID();
    await db
      .insertInto(table)
      .values({
        id,
        account_id: actor.userId,
        environment: 'sandbox',
        phone_hash: actor.phoneHash,
        platform_party_id: platformPartyId,
        agent_id: agentId,
        permissions: JSON.stringify(permissions),
        status: 'connected',
        phase: 'balances',
        invite_operation_id: randomUUID(),
        invite_idempotency_key: randomUUID(),
        accept_operation_id: randomUUID(),
        accept_idempotency_key: randomUUID(),
        invitation_id: `adi_${randomUUID()}`,
        customer_party_id: partyId,
        delegation_id: `dlg_${randomUUID()}`,
        balances: JSON.stringify([
          {
            id: randomUUID(),
            providerWalletId: walletId,
            currency: 'USD',
            availableMinor: '10000',
            totalMinor: '10000',
          },
        ]),
        first_submission_at: now,
        lease_until: null,
        generation: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async function fixture(): Promise<Fixture> {
    const sender = await account();
    const recipient = await account();
    const senderPartyId = `pty_${randomUUID()}`;
    const recipientPartyId = `pty_${randomUUID()}`;
    const senderWalletId = `wal_${randomUUID()}`;
    await connection(
      'natural_sandbox_send_connections',
      sender,
      senderPartyId,
      senderWalletId,
      sendPermissions,
    );
    await connection(
      'natural_sandbox_connections',
      recipient,
      recipientPartyId,
      `wal_${randomUUID()}`,
      readPermissions,
    );
    await sql`INSERT INTO social_contacts(id,owner_user_id,label,phone_hash,phone_ciphertext,masked_phone,connected_user_id) VALUES(${randomUUID()}::uuid,${sender.userId}::uuid,'Avery',${recipient.phoneHash},'test-ciphertext','••• 0000',${recipient.userId}::uuid)`.execute(
      db,
    );

    let lastPayment: SandboxPayment | null = null;
    const payment = (
      input: Parameters<SandboxSendGateway['send']>[0],
      status = 'COMPLETED',
    ): SandboxPayment => ({
      id: `pay_${randomUUID()}`,
      amount: input.amount,
      currency: 'USD',
      status,
      senderPartyId: input.senderPartyId,
      recipientPartyId: input.recipientPartyId,
      senderAgentId: agentId,
      paymentRequestId: null,
      tags: { app_operation_id: input.operationId },
    });
    const gateway: SandboxSendGateway = {
      getCustomer: vi.fn(async (partyId) => ({
        id: partyId,
        delegation: {
          id: `dlg_${randomUUID()}`,
          status: 'ACTIVE',
          permissions: [...sendPermissions],
        },
        agents: [{ id: agentId, status: 'ACTIVE', permissions: [...sendPermissions] }],
      })),
      getWallet: vi.fn(async () => ({
        id: senderWalletId,
        partyId: senderPartyId,
        status: 'active',
        walletType: 'standard',
        balance: { available: '10000', total: '10000', currency: 'USD' as const },
      })),
      listWallets: vi.fn(async () => [
        {
          id: senderWalletId,
          partyId: senderPartyId,
          status: 'active',
          walletType: 'standard',
          balance: { available: '10000', total: '10000', currency: 'USD' as const },
        },
      ]),
      fund: vi.fn(async (input) => ({
        id: `trf_${randomUUID()}`,
        status: 'COMPLETED',
        amount: input.amount,
        currency: 'USD' as const,
      })),
      send: vi.fn(async (input) => (lastPayment = payment(input))),
      getPayment: vi.fn(async () => lastPayment!),
      listPayments: vi.fn(async () => ({
        payments: lastPayment ? [lastPayment] : [],
        hasMore: false,
        nextCursor: null,
      })),
    };
    return {
      sender,
      recipient,
      senderPartyId,
      recipientPartyId,
      senderWalletId,
      gateway,
      service: new SandboxSendService(db, gateway, agentId, platformPartyId, () => now),
      payment,
    };
  }

  const review = (f: Fixture, amountMinor = '2600', key = randomUUID()) =>
    f.service.review(
      f.sender,
      { recipientAccountId: f.recipient.userId, amountMinor, note: 'Dinner' },
      key,
    );

  async function share(f: Fixture, environment: 'manual' | 'sandbox' = 'sandbox') {
    const expenseId = randomUUID();
    const shareId = randomUUID();
    const contact = await sql<{ id: string }>`
      INSERT INTO social_contacts
        (id,owner_user_id,label,phone_hash,phone_ciphertext,masked_phone,connected_user_id)
      VALUES (${randomUUID()}::uuid,${f.recipient.userId}::uuid,'Debtor',${f.sender.phoneHash},
              'test-ciphertext','••• 0000',${f.sender.userId}::uuid)
      ON CONFLICT (owner_user_id,phone_hash) DO UPDATE SET label='Debtor'
      RETURNING id
    `.execute(db);
    const contactId = contact.rows[0]!.id;
    await sql`
      INSERT INTO social_expenses
        (id,owner_user_id,payer_name,title,emoji,category,total_minor,currency,
         method,items,subtotal_minor,tax_minor,tip_minor,discount_minor,payment_environment)
      VALUES (${expenseId}::uuid,${f.recipient.userId}::uuid,'Avery','Dinner','🍜',
              'dinner',5200,'USD','equal','[]'::jsonb,5200,0,0,0,${environment})
    `.execute(db);
    await sql`
      INSERT INTO social_shares
        (id,expense_id,participant_id,user_id,phone_hash,private_label,
         display_name,amount_minor,is_payer)
      VALUES (${randomUUID()}::uuid,${expenseId}::uuid,${f.recipient.userId}::uuid,
              ${f.recipient.userId}::uuid,${f.recipient.phoneHash},'Avery','Avery',2600,true)
    `.execute(db);
    await sql`
      INSERT INTO social_shares
        (id,expense_id,participant_id,contact_id,user_id,phone_hash,
         private_label,display_name,amount_minor,is_payer)
      VALUES (${shareId}::uuid,${expenseId}::uuid,${contactId}::uuid,
              ${contactId}::uuid,${f.sender.userId}::uuid,${f.sender.phoneHash},
              'Debtor','Debtor',2600,false)
    `.execute(db);
    return { expenseId, shareId, contactId };
  }

  it('builds an exact server-side review without dispatch, and binds the retry key to its payload', async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await review(f, '2600', key);
    expect(first.review).toMatchObject({
      recipientName: 'Avery',
      amountMinor: '2600',
      note: 'Dinner',
    });
    expect(JSON.stringify(first)).not.toContain(f.senderPartyId);
    expect(JSON.stringify(first)).not.toContain(f.recipientPartyId);
    expect(JSON.stringify(first)).not.toContain(f.senderWalletId);
    expect(f.gateway.send).not.toHaveBeenCalled();
    const stored = await sql<{
      sender_party_id: string;
      recipient_party_id: string;
      sender_wallet_id: string;
      amount_minor: number;
      phone_hash: string;
    }>`SELECT sender_party_id,recipient_party_id,sender_wallet_id,amount_minor,phone_hash FROM natural_sandbox_send_reviews WHERE id=${first.review.id}::uuid`.execute(
      db,
    );
    expect(stored.rows[0]).toMatchObject({
      sender_party_id: f.senderPartyId,
      recipient_party_id: f.recipientPartyId,
      sender_wallet_id: f.senderWalletId,
      amount_minor: 2600,
      phone_hash: f.sender.phoneHash,
    });
    expect((await review(f, '2600', key)).review.id).toBe(first.review.id);
    await expect(review(f, '2700', key)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('dispatches exactly once for duplicate confirmation and rejects another account', async () => {
    const f = await fixture();
    const prepared = await review(f);
    await expect(f.service.confirm(f.recipient, prepared.review.id)).rejects.toMatchObject({
      code: 'REVIEW_NOT_FOUND',
    });
    const first = await f.service.confirm(f.sender, prepared.review.id);
    const second = await f.service.confirm(f.sender, prepared.review.id);
    expect(first.transfer).toEqual(second.transfer);
    expect(first.transfer.status).toBe('COMPLETED');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.gateway.send).mock.calls[0]?.[0]).toMatchObject({
      senderPartyId: f.senderPartyId,
      recipientPartyId: f.recipientPartyId,
      walletId: f.senderWalletId,
      amount: 2600,
      description: 'Dinner',
    });
    const sends = await sql<{
      operation_id: string;
      idempotency_key: string;
      status: string;
    }>`SELECT operation_id,idempotency_key,status FROM natural_sandbox_sends WHERE review_id=${prepared.review.id}::uuid`.execute(
      db,
    );
    expect(sends.rows).toHaveLength(1);
    expect(sends.rows[0]?.status).toBe('COMPLETED');
    expect(sends.rows[0]?.operation_id).toBe(
      vi.mocked(f.gateway.send).mock.calls[0]?.[0].operationId,
    );
    expect(sends.rows[0]?.idempotency_key).toBe(
      vi.mocked(f.gateway.send).mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it('pauses new sends and deposits atomically while preserving saved confirmations and reads', async () => {
    const f = await fixture();
    const prepared = await review(f);
    await setPaymentSubmissionsPaused(db, 'sandbox', true);
    try {
      await expect(f.service.confirm(f.sender, prepared.review.id)).rejects.toMatchObject({
        code: 'PAYMENTS_PAUSED',
      });
      await expect(f.service.fund(f.sender, '2500')).rejects.toMatchObject({
        code: 'PAYMENTS_PAUSED',
      });
      expect(f.gateway.send).not.toHaveBeenCalled();
      expect(f.gateway.fund).not.toHaveBeenCalled();
      const saved = await sql<{
        count: number;
      }>`SELECT count(*)::int AS count FROM natural_sandbox_sends WHERE review_id=${prepared.review.id}::uuid`.execute(
        db,
      );
      expect(saved.rows[0]?.count).toBe(0);
      await f.service.state(f.sender);
    } finally {
      await setPaymentSubmissionsPaused(db, 'sandbox', false);
    }
    const paid = await f.service.confirm(f.sender, prepared.review.id);
    await setPaymentSubmissionsPaused(db, 'sandbox', true);
    try {
      expect((await f.service.confirm(f.sender, prepared.review.id)).transfer.id).toBe(
        paid.transfer.id,
      );
      expect(f.gateway.send).toHaveBeenCalledOnce();
    } finally {
      await setPaymentSubmissionsPaused(db, 'sandbox', false);
    }
  });

  it('keeps production paused and requires fresh successful worker heartbeats', async () => {
    await expect(setPaymentSubmissionsPaused(db, 'production', false)).rejects.toThrow();
    expect(await paymentSubmissionsAllowed(db, 'production')).toBe(false);
    const instance = randomUUID();
    expect((await paymentWorkerHealth(db, 'sandbox', now)).workerHealthy).toBe(false);
    await recordPaymentWorkerHeartbeat(db, 'sandbox', instance, true, now);
    expect((await paymentWorkerHealth(db, 'sandbox', now)).workerHealthy).toBe(true);
    expect(
      (await paymentWorkerHealth(db, 'sandbox', new Date(now.getTime() + 120_001))).workerHealthy,
    ).toBe(false);
    await recordPaymentWorkerHeartbeat(db, 'sandbox', instance, false, now);
    expect((await paymentWorkerHealth(db, 'sandbox', now)).workerHealthy).toBe(false);
    await recordPaymentWorkerHeartbeat(db, 'sandbox', instance, true, now);
    expect((await paymentWorkerHealth(db, 'sandbox', now)).workerHealthy).toBe(true);
    expect((await paymentWorkerHealth(db, 'production', now)).workerHealthy).toBe(false);
  });

  it('keeps concurrent confirmations on the same saved operation while the first send is pending', async () => {
    const f = await fixture();
    const prepared = await review(f);
    let release!: () => void;
    let dispatched!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    vi.mocked(f.gateway.send).mockImplementationOnce(async (input) => {
      dispatched();
      await held;
      return f.payment(input);
    });

    const first = f.service.confirm(f.sender, prepared.review.id);
    await started;
    try {
      const second = await f.service.confirm(f.sender, prepared.review.id);
      expect(second.transfer.status).toBe('submitting');
      expect(f.gateway.send).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    const settled = await first;
    expect(settled.transfer.status).toBe('COMPLETED');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
    const saved = await sql<{
      count: number;
    }>`SELECT count(*)::integer AS count FROM natural_sandbox_sends WHERE review_id=${prepared.review.id}::uuid`.execute(
      db,
    );
    expect(saved.rows[0]?.count).toBe(1);
  });

  it('does not debit after a stale session, changed phone, recipient, or expired review', async () => {
    const f = await fixture();
    const prepared = await review(f);
    await sql`DELETE FROM auth_session WHERE id=${f.sender.sessionId}::uuid`.execute(db);
    await expect(f.service.confirm(f.sender, prepared.review.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(f.gateway.send).not.toHaveBeenCalled();

    const other = await fixture();
    const otherReview = await review(other);
    await sql`UPDATE identity_phone_bindings SET phone_hash=${randomUUID()} WHERE user_id=${other.sender.userId}::uuid`.execute(
      db,
    );
    await expect(other.service.confirm(other.sender, otherReview.review.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(other.gateway.send).not.toHaveBeenCalled();

    const moved = await fixture();
    const movedReview = await review(moved);
    await sql`UPDATE social_contacts SET connected_user_id=NULL WHERE owner_user_id=${moved.sender.userId}::uuid`.execute(
      db,
    );
    await expect(moved.service.confirm(moved.sender, movedReview.review.id)).rejects.toMatchObject({
      code: 'RECIPIENT_CHANGED',
    });
    expect(moved.gateway.send).not.toHaveBeenCalled();

    const expired = await fixture();
    const expiredReview = await review(expired);
    now = new Date(now.getTime() + 11 * 60_000);
    await expect(
      expired.service.confirm(expired.sender, expiredReview.review.id),
    ).rejects.toMatchObject({
      code: 'REVIEW_EXPIRED',
    });
    expect(expired.gateway.send).not.toHaveBeenCalled();
  });

  it('holds a definitive rejection and never submits a new payment for the same review', async () => {
    const f = await fixture();
    const prepared = await review(f);
    vi.mocked(f.gateway.send).mockRejectedValueOnce(
      new SandboxGatewayError('DECLINED', 'rejected'),
    );
    expect((await f.service.confirm(f.sender, prepared.review.id)).transfer.status).toBe('FAILED');
    expect((await f.service.confirm(f.sender, prepared.review.id)).transfer.status).toBe('FAILED');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('keeps a mismatched mutation response uncertain because the provider may have sent money', async () => {
    const f = await fixture();
    const prepared = await review(f);
    vi.mocked(f.gateway.send).mockImplementationOnce(async (input) => ({
      ...f.payment(input),
      recipientPartyId: `pty_${randomUUID()}`,
    }));
    const result = await f.service.confirm(f.sender, prepared.review.id);
    expect(result.transfer.status).toBe('unknown');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous send by its saved operation tag without a second dispatch', async () => {
    const f = await fixture();
    const prepared = await review(f);
    let accepted: SandboxPayment | null = null;
    vi.mocked(f.gateway.send).mockImplementationOnce(async (input) => {
      accepted = f.payment(input, 'PROCESSING');
      throw new SandboxGatewayError('TIMEOUT', 'unknown');
    });
    const uncertain = await f.service.confirm(f.sender, prepared.review.id);
    expect(uncertain.transfer.status).toBe('unknown');
    expect((await f.service.confirm(f.sender, prepared.review.id)).transfer.id).toBe(
      uncertain.transfer.id,
    );
    vi.mocked(f.gateway.listPayments).mockResolvedValueOnce({
      payments: [accepted!],
      hasMore: false,
      nextCursor: null,
    });
    const state = await f.service.state(f.sender);
    expect(state.transfers[0]?.status).toBe('PROCESSING');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
    expect(f.gateway.listPayments).toHaveBeenCalledTimes(1);
    const saved = await sql<{
      provider_payment_id: string;
      status: string;
    }>`SELECT provider_payment_id,status FROM natural_sandbox_sends WHERE id=${uncertain.transfer.id}::uuid`.execute(
      db,
    );
    expect(saved.rows[0]?.status).toBe('PROCESSING');
    expect(saved.rows[0]?.provider_payment_id).toBe(accepted!.id);
  });

  it('reuses the exact funding key after an unknown response and permits only one test deposit', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.fund).mockRejectedValueOnce(new SandboxGatewayError('TIMEOUT', 'unknown'));
    await f.service.fund(f.sender, '5000');
    let funding = await sql<{
      operation_id: string;
      idempotency_key: string;
      status: string;
    }>`SELECT operation_id,idempotency_key,status FROM natural_sandbox_funding WHERE account_id=${f.sender.userId}::uuid`.execute(
      db,
    );
    expect(funding.rows[0]?.status).toBe('unknown');
    await f.service.fund(f.sender, '5000');
    expect(f.gateway.fund).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.gateway.fund).mock.calls[0]?.[0]).toEqual(
      vi.mocked(f.gateway.fund).mock.calls[1]?.[0],
    );
    funding = await sql<{
      operation_id: string;
      idempotency_key: string;
      status: string;
    }>`SELECT operation_id,idempotency_key,status FROM natural_sandbox_funding WHERE account_id=${f.sender.userId}::uuid`.execute(
      db,
    );
    expect(funding.rows[0]?.status).toBe('COMPLETED');
    await f.service.fund(f.sender, '5000');
    await expect(f.service.fund(f.sender, '6000')).rejects.toMatchObject({
      code: 'TEST_DEPOSIT_EXISTS',
    });
    expect(f.gateway.fund).toHaveBeenCalledTimes(2);
  });

  it('recovers a rejected deposit with the same operation and never replaces its amount', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.fund).mockRejectedValueOnce(
      new SandboxGatewayError('FORBIDDEN_PREFLIGHT', 'rejected'),
    );
    await f.service.fund(f.sender, '2500');
    expect((await f.service.state(f.sender)).funding).toMatchObject({
      status: 'FAILED',
      retryAllowed: true,
    });
    await expect(f.service.fund(f.sender, '5000')).rejects.toMatchObject({
      code: 'TEST_DEPOSIT_EXISTS',
    });
    await f.service.fund(f.sender, '2500');
    expect(vi.mocked(f.gateway.fund).mock.calls[1]?.[0]).toEqual(
      vi.mocked(f.gateway.fund).mock.calls[0]?.[0],
    );
    expect((await f.service.state(f.sender)).funding).toMatchObject({
      status: 'COMPLETED',
      retryAllowed: false,
    });
    await f.service.fund(f.sender, '2500');
    expect(f.gateway.fund).toHaveBeenCalledTimes(2);
  });

  it('never retries a canonical failed deposit or a rejected deposit outside the retry window', async () => {
    const canonical = await fixture();
    vi.mocked(canonical.gateway.fund).mockResolvedValueOnce({
      id: `trf_${randomUUID()}`,
      status: 'FAILED',
      amount: 2500,
      currency: 'USD',
    });
    await canonical.service.fund(canonical.sender, '2500');
    expect((await canonical.service.state(canonical.sender)).funding?.retryAllowed).toBe(false);
    await canonical.service.fund(canonical.sender, '2500');
    expect(canonical.gateway.fund).toHaveBeenCalledTimes(1);

    const expired = await fixture();
    vi.mocked(expired.gateway.fund).mockRejectedValueOnce(
      new SandboxGatewayError('FORBIDDEN_PREFLIGHT', 'rejected'),
    );
    await expired.service.fund(expired.sender, '2500');
    await sql`UPDATE natural_sandbox_funding SET first_submission_at=${new Date(now.getTime() - 86400_000)} WHERE account_id=${expired.sender.userId}::uuid`.execute(
      db,
    );
    expect((await expired.service.state(expired.sender)).funding?.retryAllowed).toBe(false);
    await expect(expired.service.fund(expired.sender, '2500')).rejects.toMatchObject({
      code: 'TEST_DEPOSIT_REVIEW',
    });
    expect(expired.gateway.fund).toHaveBeenCalledTimes(1);
  });

  it('preserves an ambiguous deposit when a later preflight is rejected', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.fund)
      .mockRejectedValueOnce(new SandboxGatewayError('TIMEOUT', 'unknown'))
      .mockRejectedValueOnce(new SandboxGatewayError('FORBIDDEN_PREFLIGHT', 'rejected'));
    await f.service.fund(f.sender, '2500');
    await f.service.fund(f.sender, '2500');
    expect((await f.service.state(f.sender)).funding).toMatchObject({
      status: 'unknown',
      retryAllowed: true,
    });
  });

  it('recovers an interrupted deposit after its lease expires using the saved key', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.fund).mockRejectedValueOnce(new SandboxGatewayError('TIMEOUT', 'unknown'));
    await f.service.fund(f.sender, '2500');
    await sql`UPDATE natural_sandbox_funding SET status='submitting',lease_until=${new Date(now.getTime() + 30_000)} WHERE account_id=${f.sender.userId}::uuid`.execute(
      db,
    );
    expect((await f.service.state(f.sender)).funding?.retryAllowed).toBe(false);
    await f.service.fund(f.sender, '2500');
    expect(f.gateway.fund).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 31_000);
    expect((await f.service.state(f.sender)).funding).toMatchObject({
      status: 'unknown',
      retryAllowed: true,
    });
    await f.service.fund(f.sender, '2500');
    expect(vi.mocked(f.gateway.fund).mock.calls[1]?.[0]).toEqual(
      vi.mocked(f.gateway.fund).mock.calls[0]?.[0],
    );
  });

  it('shows the current provider balance after funding and sending', async () => {
    const f = await fixture();
    let available = '10000';
    const liveWallet = () => ({
      id: f.senderWalletId,
      partyId: f.senderPartyId,
      status: 'active',
      walletType: 'standard',
      balance: { available, total: available, currency: 'USD' as const },
    });
    vi.mocked(f.gateway.getWallet).mockImplementation(async () => liveWallet());
    vi.mocked(f.gateway.listWallets).mockImplementation(async () => [liveWallet()]);

    await f.service.fund(f.sender, '5000');
    available = '15000';
    expect((await f.service.state(f.sender)).connection?.balances[0]?.availableMinor).toBe('15000');

    const prepared = await review(f);
    expect((await f.service.confirm(f.sender, prepared.review.id)).transfer.status).toBe(
      'COMPLETED',
    );
    available = '12400';
    expect((await f.service.state(f.sender)).connection?.balances[0]?.availableMinor).toBe('12400');
  });

  it('does not regress a returned payment when a stale completed read arrives later', async () => {
    const f = await fixture();
    const prepared = await review(f);
    const completed = await f.service.confirm(f.sender, prepared.review.id);
    expect(completed.transfer.status).toBe('COMPLETED');
    const original = await vi.mocked(f.gateway.send).mock.results[0]!.value;
    vi.mocked(f.gateway.getPayment).mockResolvedValueOnce({ ...original, status: 'RETURNED' });
    expect((await f.service.state(f.sender)).transfers[0]?.status).toBe('RETURNED');
    vi.mocked(f.gateway.getPayment).mockResolvedValueOnce({ ...original, status: 'COMPLETED' });
    expect((await f.service.state(f.sender)).transfers[0]?.status).toBe('RETURNED');
  });

  it('hides the spendable balance when current agent access is revoked without restarting setup', async () => {
    const f = await fixture();
    const customer = await f.gateway.getCustomer(f.senderPartyId);
    vi.mocked(f.gateway.getCustomer).mockResolvedValue({
      ...customer,
      agents: customer.agents.map((agent) => ({ ...agent, status: 'REVOKED' })),
    });
    const state = await f.service.state(f.sender);
    expect(state.connection?.balances[0]?.availableMinor).toBeNull();
    expect(f.gateway.listWallets).not.toHaveBeenCalled();
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM natural_sandbox_send_connections WHERE account_id=${f.sender.userId}::uuid`.execute(
          db,
        )
      ).rows[0]?.status,
    ).toBe('connected');
    await expect(review(f)).rejects.toMatchObject({ code: 'TEST_ACCESS_CHANGED' });
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('binds a sandbox share to its debtor, owner, current phone, amount and receiving customer', async () => {
    const f = await fixture();
    const s = await share(f);
    const key = randomUUID();
    const prepared = await f.service.reviewShare(f.sender, { shareId: s.shareId }, key);
    expect(prepared.review).toMatchObject({
      shareId: s.shareId,
      recipientName: 'Avery',
      amountMinor: '2600',
      note: 'Dinner',
    });
    expect(JSON.stringify(prepared)).not.toContain(f.recipientPartyId);
    expect(f.gateway.send).not.toHaveBeenCalled();
    expect((await f.service.reviewShare(f.sender, { shareId: s.shareId }, key)).review.id).toBe(
      prepared.review.id,
    );
    await expect(
      f.service.confirmShare(f.sender, { shareId: randomUUID(), reviewId: prepared.review.id }),
    ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    expect(f.gateway.send).not.toHaveBeenCalled();
    const confirmed = await f.service.confirmShare(f.sender, {
      shareId: s.shareId,
      reviewId: prepared.review.id,
    });
    expect(confirmed.transfer).toMatchObject({
      shareId: s.shareId,
      amountMinor: '2600',
      status: 'COMPLETED',
    });
    expect(vi.mocked(f.gateway.send).mock.calls[0]?.[0]).toMatchObject({
      senderPartyId: f.senderPartyId,
      recipientPartyId: f.recipientPartyId,
      amount: 2600,
      description: 'Dinner',
    });
    expect((await f.service.shareState(f.sender, s.shareId)).status).toBe('paid');
    const ownerState = await f.service.shareState(f.recipient, s.shareId);
    expect(ownerState).toMatchObject({ status: 'paid', amountMinor: '2600', canReview: false });
    expect(ownerState.sourceAvailableMinor).toBeNull();
    expect(ownerState.funding).toBeNull();
    expect(JSON.stringify(ownerState)).not.toContain(f.senderPartyId);
    expect(JSON.stringify(ownerState)).not.toContain(f.recipientPartyId);
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('rejects manual or spoofed shares and never lets the creditor authorize the debtor debit', async () => {
    const f = await fixture();
    const manual = await share(f, 'manual');
    await expect(
      f.service.reviewShare(f.sender, { shareId: manual.shareId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SHARE_NOT_PAYABLE' });
    expect((await f.service.shareState(f.sender, manual.shareId)).status).toBe('manual');
    const sandbox = await share(f);
    await expect(
      f.service.reviewShare(f.recipient, { shareId: sandbox.shareId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
    await expect(f.service.shareState(await account(), sandbox.shareId)).rejects.toMatchObject({
      code: 'SHARE_NOT_FOUND',
    });
    await expect(
      f.service.reviewShare(f.sender, { shareId: randomUUID() }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('holds one reservation across distinct reviews, even during a pending provider call', async () => {
    const f = await fixture();
    const s = await share(f);
    const firstReview = await f.service.reviewShare(f.sender, { shareId: s.shareId }, randomUUID());
    const secondReview = await f.service.reviewShare(
      f.sender,
      { shareId: s.shareId },
      randomUUID(),
    );
    let release!: () => void;
    let dispatched!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (dispatched = resolve));
    vi.mocked(f.gateway.send).mockImplementationOnce(async (input) => {
      dispatched();
      await held;
      return f.payment(input);
    });
    const first = f.service.confirmShare(f.sender, {
      shareId: s.shareId,
      reviewId: firstReview.review.id,
    });
    await started;
    try {
      await expect(
        f.service.confirmShare(f.sender, {
          shareId: s.shareId,
          reviewId: secondReview.review.id,
        }),
      ).rejects.toMatchObject({ code: 'SHARE_PAYMENT_IN_PROGRESS' });
      await expect(
        f.service.reviewShare(f.sender, { shareId: s.shareId }, randomUUID()),
      ).rejects.toMatchObject({ code: 'SHARE_PAYMENT_IN_PROGRESS' });
      expect(f.gateway.send).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await first).transfer.status).toBe('COMPLETED');
    await expect(
      f.service.confirmShare(f.sender, { shareId: s.shareId, reviewId: secondReview.review.id }),
    ).rejects.toMatchObject({ code: 'SHARE_PAYMENT_IN_PROGRESS' });
    const count = await sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM natural_sandbox_sends WHERE share_id=${s.shareId}::uuid
    `.execute(db);
    expect(count.rows[0]?.count).toBe(1);
  });

  it('serializes cancellation before confirmation and rejects a rebound recipient', async () => {
    const canceled = await fixture();
    const c = await share(canceled);
    const prepared = await canceled.service.reviewShare(
      canceled.sender,
      { shareId: c.shareId },
      randomUUID(),
    );
    await sql`UPDATE social_shares SET canceled_at=${now} WHERE id=${c.shareId}::uuid`.execute(db);
    await expect(
      canceled.service.confirmShare(canceled.sender, {
        shareId: c.shareId,
        reviewId: prepared.review.id,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_CANCELED' });
    expect(canceled.gateway.send).not.toHaveBeenCalled();

    const rebound = await fixture();
    const r = await share(rebound);
    const reviewed = await rebound.service.reviewShare(
      rebound.sender,
      { shareId: r.shareId },
      randomUUID(),
    );
    await sql`
      UPDATE natural_sandbox_connections SET customer_party_id=${`pty_${randomUUID()}`}
      WHERE account_id=${rebound.recipient.userId}::uuid
    `.execute(db);
    await expect(
      rebound.service.confirmShare(rebound.sender, {
        shareId: r.shareId,
        reviewId: reviewed.review.id,
      }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_CHANGED' });
    expect(rebound.gateway.send).not.toHaveBeenCalled();
  });

  it('lets a concurrent cancellation win the expense lock before any provider call', async () => {
    const f = await fixture();
    const s = await share(f);
    const prepared = await f.service.reviewShare(f.sender, { shareId: s.shareId }, randomUUID());
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const cancel = db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM social_expenses WHERE id=${s.expenseId}::uuid FOR UPDATE`.execute(
        tx,
      );
      locked();
      await held;
      await sql`UPDATE social_shares SET canceled_at=${now} WHERE id=${s.shareId}::uuid`.execute(
        tx,
      );
    });
    await acquired;
    const confirm = f.service.confirmShare(f.sender, {
      shareId: s.shareId,
      reviewId: prepared.review.id,
    });
    release();
    await cancel;
    await expect(confirm).rejects.toMatchObject({ code: 'SHARE_CANCELED' });
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('rejects a changed share amount and an outdated review after canonical failure', async () => {
    const changed = await fixture();
    const c = await share(changed);
    const review = await changed.service.reviewShare(
      changed.sender,
      { shareId: c.shareId },
      randomUUID(),
    );
    await sql`UPDATE social_shares SET amount_minor=2700 WHERE id=${c.shareId}::uuid`.execute(db);
    await expect(
      changed.service.confirmShare(changed.sender, {
        shareId: c.shareId,
        reviewId: review.review.id,
      }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_CHANGED' });
    expect(changed.gateway.send).not.toHaveBeenCalled();

    const failed = await fixture();
    const s = await share(failed);
    const stale = await failed.service.reviewShare(
      failed.sender,
      { shareId: s.shareId },
      randomUUID(),
    );
    const first = await failed.service.reviewShare(
      failed.sender,
      { shareId: s.shareId },
      randomUUID(),
    );
    vi.mocked(failed.gateway.send).mockImplementationOnce(async (input) =>
      failed.payment(input, 'FAILED'),
    );
    expect(
      (
        await failed.service.confirmShare(failed.sender, {
          shareId: s.shareId,
          reviewId: first.review.id,
        })
      ).transfer.status,
    ).toBe('FAILED');
    await expect(
      failed.service.confirmShare(failed.sender, {
        shareId: s.shareId,
        reviewId: stale.review.id,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
    const fresh = await failed.service.reviewShare(
      failed.sender,
      { shareId: s.shareId },
      randomUUID(),
    );
    expect(fresh.review.id).not.toBe(first.review.id);
    expect(failed.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown share debit reserved and requires a new review after a canonical return', async () => {
    const rejected = await fixture();
    const rejectedShare = await share(rejected);
    const rejectedReview = await rejected.service.reviewShare(
      rejected.sender,
      { shareId: rejectedShare.shareId },
      randomUUID(),
    );
    vi.mocked(rejected.gateway.send).mockRejectedValueOnce(
      new SandboxGatewayError('DECLINED', 'rejected'),
    );
    expect(
      (
        await rejected.service.confirmShare(rejected.sender, {
          shareId: rejectedShare.shareId,
          reviewId: rejectedReview.review.id,
        })
      ).transfer.status,
    ).toBe('FAILED');
    expect(
      await rejected.service.shareState(rejected.recipient, rejectedShare.shareId),
    ).toMatchObject({ status: 'unknown', canReview: false });

    const uncertain = await fixture();
    const u = await share(uncertain);
    const unknownReview = await uncertain.service.reviewShare(
      uncertain.sender,
      { shareId: u.shareId },
      randomUUID(),
    );
    vi.mocked(uncertain.gateway.send).mockRejectedValueOnce(
      new SandboxGatewayError('TIMEOUT', 'unknown'),
    );
    expect(
      (
        await uncertain.service.confirmShare(uncertain.sender, {
          shareId: u.shareId,
          reviewId: unknownReview.review.id,
        })
      ).transfer.status,
    ).toBe('unknown');
    await expect(
      uncertain.service.reviewShare(uncertain.sender, { shareId: u.shareId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SHARE_PAYMENT_IN_PROGRESS' });
    expect(uncertain.gateway.send).toHaveBeenCalledTimes(1);

    const returned = await fixture();
    const r = await share(returned);
    const stale = await returned.service.reviewShare(
      returned.sender,
      { shareId: r.shareId },
      randomUUID(),
    );
    const firstReview = await returned.service.reviewShare(
      returned.sender,
      { shareId: r.shareId },
      randomUUID(),
    );
    await returned.service.confirmShare(returned.sender, {
      shareId: r.shareId,
      reviewId: firstReview.review.id,
    });
    const original = await vi.mocked(returned.gateway.send).mock.results[0]!.value;
    vi.mocked(returned.gateway.getPayment).mockResolvedValueOnce({
      ...original,
      status: 'RETURNED',
    });
    expect((await returned.service.shareState(returned.recipient, r.shareId)).status).toBe(
      'returned',
    );
    await expect(
      returned.service.confirmShare(returned.sender, {
        shareId: r.shareId,
        reviewId: stale.review.id,
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
    const fresh = await returned.service.reviewShare(
      returned.sender,
      { shareId: r.shareId },
      randomUUID(),
    );
    expect(fresh.review.id).not.toBe(firstReview.review.id);
    expect(
      (
        await returned.service.confirmShare(returned.sender, {
          shareId: r.shareId,
          reviewId: fresh.review.id,
        })
      ).transfer.status,
    ).toBe('COMPLETED');
    expect(returned.gateway.send).toHaveBeenCalledTimes(2);
  });
});
