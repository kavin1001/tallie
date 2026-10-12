import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@tallie/db';
import { migrate } from '../../db/src/migrate';
import type { PaymentDatabase } from './schema';
import type { SandboxPayment } from './send-service';
import {
  SandboxPaymentReconciliationService,
  type SandboxDepositObservation,
  type SandboxReconciliationGateway,
} from './reconciliation';

config({ quiet: true });
const agentId = 'agt_test_reconciliation';
const platformPartyId = 'pty_test_platform';
const initialTime = new Date('2026-09-26T12:00:00Z');
const DAY_MS = 86_400_000;

describe('durable sandbox canonical reconciliation', () => {
  const schema = `tallie_reconciliation_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = initialTime;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Tests require local PostgreSQL.');
    admin = new Pool({ connectionString: url.toString(), max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString()) as unknown as Kysely<PaymentDatabase>;
  });

  afterEach(async () => {
    await sql`TRUNCATE auth_user CASCADE`.execute(db);
    now = initialTime;
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  function advance(ms: number) {
    now = new Date(now.getTime() + ms);
  }

  async function fixture(
    options: {
      kind?: 'send' | 'funding';
      status?: string;
      canonical?: boolean;
      activeLease?: boolean;
    } = {},
  ) {
    const accountId = randomUUID();
    const connectionId = randomUUID();
    const reviewId = randomUUID();
    const id = randomUUID();
    const operationId = randomUUID();
    const kind = options.kind ?? 'send';
    const providerId = `${kind === 'send' ? 'pay' : 'trf'}_${randomUUID()}`;
    const senderPartyId = `pty_${randomUUID()}`;
    const recipientPartyId = `pty_${randomUUID()}`;
    const walletId = `wal_${randomUUID()}`;
    await sql`INSERT INTO auth_user(id,name,email)
      VALUES(${accountId}::uuid,'Reconciliation fixture',${`${accountId}@test.invalid`})`.execute(
      db,
    );
    await db
      .insertInto('natural_sandbox_send_connections')
      .values({
        id: connectionId,
        account_id: accountId,
        environment: 'sandbox',
        phone_hash: 'fixture',
        platform_party_id: platformPartyId,
        agent_id: agentId,
        permissions: JSON.stringify(['payments.read']),
        status: 'connected',
        phase: 'balances',
        invite_operation_id: randomUUID(),
        invite_idempotency_key: randomUUID(),
        accept_operation_id: randomUUID(),
        accept_idempotency_key: randomUUID(),
        invitation_id: `adi_${randomUUID()}`,
        customer_party_id: senderPartyId,
        delegation_id: 'fixture',
        balances: '[]',
        first_submission_at: now,
        lease_until: null,
        generation: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const canonical = options.canonical === false ? null : providerId;
    const lease = options.activeLease ? new Date(now.getTime() + 30_000) : null;
    if (kind === 'send') {
      await sql`INSERT INTO natural_sandbox_send_reviews
        (id,account_id,client_request_key,phone_hash,sender_connection_id,sender_party_id,
         sender_wallet_id,recipient_party_id,recipient_name,amount_minor,note,status,created_at,expires_at,confirmed_at)
        VALUES(${reviewId}::uuid,${accountId}::uuid,${randomUUID()}::uuid,'fixture',${connectionId}::uuid,
          ${senderPartyId},${walletId},${recipientPartyId},'Friend',100,'Test','confirmed',${now},${now},${now})`.execute(
        db,
      );
      await sql`INSERT INTO natural_sandbox_sends
        (id,review_id,account_id,operation_id,idempotency_key,provider_payment_id,status,
         first_submission_at,lease_until,created_at,updated_at)
        VALUES(${id}::uuid,${reviewId}::uuid,${accountId}::uuid,${operationId}::uuid,${randomUUID()}::uuid,
          ${canonical},${options.status ?? 'PROCESSING'},${now},${lease},${now},${now})`.execute(
        db,
      );
    } else {
      await sql`INSERT INTO natural_sandbox_funding
        (id,account_id,sender_connection_id,customer_party_id,wallet_id,amount_minor,operation_id,
         idempotency_key,provider_transfer_id,status,first_submission_at,lease_until,created_at,updated_at)
        VALUES(${id}::uuid,${accountId}::uuid,${connectionId}::uuid,${senderPartyId},${walletId},100,
          ${operationId}::uuid,${randomUUID()}::uuid,${canonical},${options.status ?? 'PROCESSING'},
          ${now},${lease},${now},${now})`.execute(db);
    }
    const payment: SandboxPayment = {
      id: providerId,
      amount: 100,
      currency: 'USD',
      status: 'COMPLETED',
      senderPartyId,
      recipientPartyId,
      senderAgentId: agentId,
      paymentRequestId: null,
      tags: { app_operation_id: operationId },
    };
    const deposit: SandboxDepositObservation = {
      id: providerId,
      type: 'deposit',
      partyId: senderPartyId,
      walletId,
      amount: 100,
      currency: 'USD',
      status: 'COMPLETED',
    };
    const gateway: SandboxReconciliationGateway = {
      getPayment: vi.fn(async () => payment),
      listPayments: vi.fn(async () => ({ payments: [], hasMore: false, nextCursor: null })),
      getDeposit: vi.fn(async () => deposit),
    };
    const service = new SandboxPaymentReconciliationService(
      db,
      gateway,
      agentId,
      platformPartyId,
      () => now,
    );
    const journal = async () => {
      const table =
        kind === 'send' ? sql.table('natural_sandbox_sends') : sql.table('natural_sandbox_funding');
      return (
        await sql<{
          status: string;
          provider_payment_id?: string | null;
          provider_transfer_id?: string | null;
        }>`
        SELECT * FROM ${table} WHERE id=${id}::uuid`.execute(db)
      ).rows[0]!;
    };
    const job = async () =>
      (
        await sql<{
          status: string;
          available_at: Date;
          lease_token: string | null;
          attempts: number;
          consecutive_failures: number;
          scan_cursor: string | null;
          attention_reason: string | null;
        }>`SELECT * FROM natural_sandbox_reconciliation_jobs
      WHERE send_id=${id}::uuid OR funding_id=${id}::uuid`.execute(db)
      ).rows[0]!;
    return { id, operationId, providerId, payment, deposit, gateway, service, journal, job };
  }

  it('enqueues atomically with the journal and completes without an account session or browser', async () => {
    const f = await fixture();
    expect((await f.job()).status).toBe('ready');
    expect(await f.service.processOne()).toBe(true);
    expect((await f.journal()).status).toBe('COMPLETED');
    expect((await f.job()).available_at.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(await f.service.processOne()).toBe(false);
    expect(f.gateway.getPayment).toHaveBeenCalledExactlyOnceWith({
      senderPartyId: f.payment.senderPartyId,
      recipientPartyId: f.payment.recipientPartyId,
      amount: 100,
      paymentId: f.providerId,
    });
  });

  it('backfills existing journals on upgrade and resumes through a new service without resetting completion age', async () => {
    const send = await fixture({ status: 'COMPLETED' });
    const funding = await fixture({ kind: 'funding', activeLease: true });
    await sql`UPDATE natural_sandbox_sends SET updated_at=${new Date(now.getTime() - 61 * DAY_MS)}
      WHERE id=${send.id}::uuid`.execute(db);
    // Recreate exactly the pre-017 state inside this suite's isolated schema.
    const migration = await readFile(
      new URL('../../db/migrations/017_sandbox_reconciliation.sql', import.meta.url),
      'utf8',
    );
    await db.transaction().execute(async (tx) => {
      await sql
        .raw(
          `
        DROP TRIGGER natural_sandbox_sends_reconcile ON natural_sandbox_sends;
        DROP TRIGGER natural_sandbox_funding_reconcile ON natural_sandbox_funding;
        DROP FUNCTION enqueue_natural_sandbox_reconciliation();
        DROP TABLE natural_sandbox_reconciliation_jobs;
      `,
        )
        .execute(tx);
      await sql.raw(migration).execute(tx);
    });
    const restarted = new SandboxPaymentReconciliationService(
      db,
      send.gateway,
      agentId,
      platformPartyId,
      () => now,
    );
    expect(await restarted.processOne()).toBe(true);
    expect((await send.job()).attention_reason).toBe('monitor_window_closed');
    expect((await send.job()).status).toBe('paused');
    expect((await funding.job()).attempts).toBe(0);
    expect(await funding.service.processOne()).toBe(false);
    advance(30_001);
    expect(await funding.service.processOne()).toBe(true);
    expect((await funding.journal()).status).toBe('COMPLETED');
  });

  it('leases one job across workers and holds no journal lock during a provider read', async () => {
    const f = await fixture();
    let release!: (payment: SandboxPayment) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.gateway.getPayment).mockImplementation(async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const running = f.service.processOne();
    await entered;
    expect(await f.service.processOne()).toBe(false);
    await db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM natural_sandbox_sends WHERE id=${f.id}::uuid FOR UPDATE NOWAIT`.execute(
        tx,
      );
    });
    release(f.payment);
    await running;
    expect(f.gateway.getPayment).toHaveBeenCalledTimes(1);
    expect((await f.job()).lease_token).toBeNull();
  });

  it('recovers an expired lease and fences an old worker from changing its replacement result', async () => {
    const f = await fixture();
    let release!: (payment: SandboxPayment) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.gateway.getPayment)
      .mockImplementationOnce(async () => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce({ ...f.payment, status: 'RETURNED' });
    const first = f.service.processOne();
    await entered;
    advance(91_000);
    expect(await f.service.processOne()).toBe(true);
    release(f.payment);
    await first;
    expect((await f.journal()).status).toBe('RETURNED');
    expect((await f.job()).attempts).toBe(2);
    expect((await f.job()).status).toBe('paused');
  });

  it('continues a bounded unknown-payment scan across claims without issuing a mutation', async () => {
    const f = await fixture({ status: 'unknown', canonical: false });
    vi.mocked(f.gateway.listPayments)
      .mockResolvedValueOnce({ payments: [], hasMore: true, nextCursor: 'page2' })
      .mockResolvedValueOnce({ payments: [], hasMore: true, nextCursor: 'page3' })
      .mockResolvedValueOnce({ payments: [], hasMore: true, nextCursor: 'page4' })
      .mockResolvedValueOnce({ payments: [f.payment], hasMore: false, nextCursor: null });
    await f.service.processOne();
    expect((await f.job()).scan_cursor).toBe('page4');
    expect((await f.journal()).status).toBe('unknown');
    expect(f.gateway.listPayments).toHaveBeenCalledTimes(3);
    advance(15_001);
    await f.service.processOne();
    expect(f.gateway.listPayments).toHaveBeenLastCalledWith({
      senderPartyId: f.payment.senderPartyId,
      limit: 100,
      cursor: 'page4',
    });
    expect((await f.journal()).provider_payment_id).toBe(f.providerId);
    expect((await f.journal()).status).toBe('COMPLETED');
  });

  it('retains an unresolved operation after a complete empty scan with increasing backoff', async () => {
    const f = await fixture({ status: 'unknown', canonical: false });
    await f.service.processOne();
    expect((await f.job()).attention_reason).toBe('unresolved_operation');
    expect((await f.journal()).provider_payment_id).toBeNull();
    expect(await f.service.processOne()).toBe(false);
    advance(15_001);
    await f.service.processOne();
    expect((await f.job()).consecutive_failures).toBe(2);
    expect((await f.job()).available_at.getTime()).toBe(now.getTime() + 30_000);
    expect((await f.journal()).status).toBe('unknown');
  });

  it('bounds a repeated pagination cursor and rejects duplicate operation matches', async () => {
    const f = await fixture({ status: 'unknown', canonical: false });
    vi.mocked(f.gateway.listPayments).mockResolvedValue({
      payments: [],
      hasMore: true,
      nextCursor: 'same',
    });
    await f.service.processOne();
    expect(f.gateway.listPayments).toHaveBeenCalledTimes(2);
    expect((await f.job()).attention_reason).toBe('provider_unavailable');
    advance(15_001);
    vi.mocked(f.gateway.listPayments).mockResolvedValue({
      payments: [f.payment, { ...f.payment, id: 'pay_other' }],
      hasMore: false,
      nextCursor: null,
    });
    await f.service.processOne();
    expect((await f.job()).attention_reason).toBe('binding_mismatch');
    expect((await f.journal()).provider_payment_id).toBeNull();
  });

  it.each(['amount', 'senderPartyId', 'recipientPartyId', 'senderAgentId', 'tags', 'id'] as const)(
    'refuses a mismatched canonical %s',
    async (field) => {
      const f = await fixture();
      const mismatch = {
        ...f.payment,
        [field]: field === 'amount' ? 101 : field === 'tags' ? {} : 'wrong',
      };
      vi.mocked(f.gateway.getPayment).mockResolvedValue(mismatch as SandboxPayment);
      await f.service.processOne();
      expect((await f.journal()).status).toBe('PROCESSING');
      expect((await f.job()).attention_reason).toBe('binding_mismatch');
    },
  );

  it('retains canonical state on read failures and frees its lease for a delayed retry', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.getPayment).mockRejectedValue(
      new Error('provider detail must not be stored'),
    );
    await f.service.processOne();
    expect((await f.journal()).status).toBe('PROCESSING');
    expect((await f.job()).attention_reason).toBe('provider_unavailable');
    expect((await f.job()).lease_token).toBeNull();
    expect(await f.service.processOne()).toBe(false);
  });

  it('observes a late return and never regresses it on stale completion', async () => {
    const f = await fixture({ status: 'COMPLETED' });
    await f.service.processOne();
    advance(15 * 60_000);
    vi.mocked(f.gateway.getPayment).mockResolvedValue({ ...f.payment, status: 'RETURNED' });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('RETURNED');
    expect((await f.job()).status).toBe('paused');
    await f.service.wake({ kind: 'send', providerId: f.providerId });
    vi.mocked(f.gateway.getPayment).mockResolvedValue(f.payment);
    await f.service.processOne();
    expect((await f.journal()).status).toBe('RETURNED');
  });

  it('stops scheduled completion reads after the observation window but a webhook can reopen them', async () => {
    const f = await fixture({ status: 'COMPLETED' });
    advance(61 * DAY_MS);
    await f.service.processOne();
    expect((await f.job()).status).toBe('paused');
    expect((await f.job()).attention_reason).toBe('monitor_window_closed');
    expect(await f.service.processOne()).toBe(false);
    expect(await f.service.wake({ kind: 'send', providerId: f.providerId })).toBe(1);
    vi.mocked(f.gateway.getPayment).mockResolvedValue({ ...f.payment, status: 'RETURNED' });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('RETURNED');
  });

  it('does not lose a wake-up received during the provider call', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.getPayment).mockImplementation(async () => {
      await f.service.wake({ kind: 'send', providerId: f.providerId });
      return f.payment;
    });
    await f.service.processOne();
    expect((await f.job()).available_at.getTime()).toBe(now.getTime());
    vi.mocked(f.gateway.getPayment).mockResolvedValue(f.payment);
    expect(await f.service.processOne()).toBe(true);
    expect(await f.service.processOne()).toBe(false);
  });

  it('waits for the original dispatch lease before canonical recovery', async () => {
    const f = await fixture({ status: 'submitting', canonical: false, activeLease: true });
    expect(await f.service.processOne()).toBe(false);
    advance(30_001);
    expect(await f.service.processOne()).toBe(true);
    expect((await f.journal()).status).toBe('unknown');
  });

  it('scopes claims and hints to the configured platform and agent', async () => {
    const f = await fixture();
    const wrong = new SandboxPaymentReconciliationService(
      db,
      f.gateway,
      'another_agent',
      platformPartyId,
      () => now,
    );
    expect(await wrong.processOne()).toBe(false);
    expect(await wrong.wake({ kind: 'send', providerId: f.providerId })).toBe(0);
    expect(await f.service.wake({ kind: 'send', providerId: 'wrong' })).toBe(0);
    expect(
      await f.service.wake({ kind: 'send', providerId: f.providerId, operationId: randomUUID() }),
    ).toBe(0);
    expect(await f.service.wake({ kind: 'send', operationId: f.operationId })).toBe(1);
  });

  it('uses canonical reads for a saved deposit and continues watching for a return', async () => {
    const f = await fixture({ kind: 'funding' });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('COMPLETED');
    expect(f.gateway.getDeposit).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: f.deposit.partyId,
      walletId: f.deposit.walletId,
      amount: 100,
      transferId: f.providerId,
    });
    advance(15 * 60_000);
    vi.mocked(f.gateway.getDeposit).mockResolvedValue({ ...f.deposit, status: 'RETURNED' });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('RETURNED');
    expect((await f.job()).status).toBe('paused');
  });

  it('preserves an unknown deposit for attention without guessing or replaying it', async () => {
    const f = await fixture({ kind: 'funding', status: 'submitting', canonical: false });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('unknown');
    expect((await f.job()).status).toBe('paused');
    expect((await f.job()).attention_reason).toBe('deposit_identity_unknown');
    expect(f.gateway.getDeposit).not.toHaveBeenCalled();
    expect(f.gateway.listPayments).not.toHaveBeenCalled();
  });

  it('refuses a deposit belonging to another wallet even with the expected resource ID', async () => {
    const f = await fixture({ kind: 'funding' });
    vi.mocked(f.gateway.getDeposit).mockResolvedValue({ ...f.deposit, walletId: 'other_wallet' });
    await f.service.processOne();
    expect((await f.journal()).status).toBe('PROCESSING');
    expect((await f.job()).attention_reason).toBe('binding_mismatch');
  });
});
