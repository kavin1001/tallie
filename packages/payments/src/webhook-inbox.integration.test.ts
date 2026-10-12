import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { Webhook } from 'standardwebhooks';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@tallie/db';
import { migrate } from '../../db/src/migrate';
import type { PaymentDatabase } from './schema';
import { NaturalWebhookInboxService } from './webhook-inbox';
import { verifyNaturalEvent } from './webhook-verification';

config({ quiet: true });
const providerId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const platformPartyId = providerId('pty');
const agentId = providerId('agt');
const senderPartyId = providerId('pty');
const recipientPartyId = providerId('pty');
const unrelatedPartyId = providerId('pty');
const paymentId = providerId('pay');
const fundingId = providerId('trf');
const operationId = randomUUID();
const depositOperationId = randomUUID();
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const options = {
  environment: 'sandbox' as const,
  platformPartyId,
  agentId,
  encryptionKey: randomBytes(32).toString('hex'),
};
const initialNow = new Date();

describe('durable Natural inbox and bound reconciliation hints', () => {
  const schema = `tallie_webhook_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = new Date(initialNow);
  let service: NaturalWebhookInboxService;
  let sendId: string;
  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error('Local PostgreSQL is required.');
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Local PostgreSQL only.');
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString()) as unknown as Kysely<PaymentDatabase>;
    const sender = await connectionRow(senderPartyId);
    await connectionRow(recipientPartyId);
    await connectionRow(unrelatedPartyId);
    const reviewId = randomUUID();
    sendId = randomUUID();
    await sql`INSERT INTO natural_sandbox_send_reviews(id,account_id,client_request_key,phone_hash,
      sender_connection_id,sender_party_id,sender_wallet_id,recipient_party_id,recipient_name,
      amount_minor,note,status,created_at,expires_at,confirmed_at)
      VALUES(${reviewId}::uuid,${sender.accountId}::uuid,${randomUUID()}::uuid,'test',
      ${sender.id}::uuid,${senderPartyId},${providerId('wal')},${recipientPartyId},'Synthetic recipient',
      100,'Synthetic test','confirmed',${now},${new Date(now.getTime() + 600000)},${now})`.execute(
      db,
    );
    await sql`INSERT INTO natural_sandbox_sends(id,review_id,account_id,operation_id,idempotency_key,
      provider_payment_id,status,first_submission_at,created_at,updated_at)
      VALUES(${sendId}::uuid,${reviewId}::uuid,${sender.accountId}::uuid,${operationId}::uuid,
      ${randomUUID()}::uuid,${paymentId},'PROCESSING',${now},${now},${now})`.execute(db);
    await sql`INSERT INTO natural_sandbox_funding(id,account_id,sender_connection_id,customer_party_id,
      wallet_id,amount_minor,operation_id,idempotency_key,provider_transfer_id,status)
      VALUES(${randomUUID()}::uuid,${sender.accountId}::uuid,${sender.id}::uuid,${senderPartyId},
      ${providerId('wal')},500,${depositOperationId}::uuid,${randomUUID()}::uuid,${fundingId},'PROCESSING')`.execute(
      db,
    );
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    now = new Date(initialNow);
    service = new NaturalWebhookInboxService(db, options, () => now);
    await sql`DELETE FROM natural_webhook_inbox`.execute(db);
    await sql`UPDATE natural_sandbox_sends SET provider_payment_id=${paymentId} WHERE id=${sendId}::uuid`.execute(
      db,
    );
  });
  async function connectionRow(partyId: string) {
    const accountId = randomUUID();
    const id = randomUUID();
    await sql`INSERT INTO auth_user(id,name,email) VALUES(${accountId}::uuid,'Synthetic',${`${accountId}@test.invalid`})`.execute(
      db,
    );
    await sql`INSERT INTO natural_sandbox_send_connections(id,account_id,environment,phone_hash,
      platform_party_id,agent_id,permissions,status,phase,invite_operation_id,invite_idempotency_key,
      accept_operation_id,accept_idempotency_key,invitation_id,customer_party_id,delegation_id)
      VALUES(${id}::uuid,${accountId}::uuid,'sandbox','test',${platformPartyId},${agentId},'[]',
      'connected','balances',${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,
      ${randomUUID()}::uuid,${providerId('adi')},${partyId},${providerId('dlg')})`.execute(db);
    return { accountId, id };
  }
  function event(
    input: {
      id?: string;
      type?: string;
      source?: string;
      resourceId?: string;
      operation?: string;
      note?: string;
      sender?: string;
    } = {},
  ) {
    const deposit = input.type?.startsWith('deposit.');
    const id = input.id ?? providerId('evt');
    const resourceId = input.resourceId ?? (deposit ? fundingId : paymentId);
    const raw = Buffer.from(
      JSON.stringify({
        id,
        object: 'event',
        type: input.type ?? 'payment.completed',
        sourcePartyId: input.source ?? senderPartyId,
        resourceType: deposit ? 'transfer' : 'payment',
        resourceId,
        createdAt: initialNow.toISOString(),
        data: {
          object: {
            id: resourceId,
            type: deposit ? 'deposit' : 'payment',
            senderPartyId: input.sender ?? senderPartyId,
            recipientPartyId,
            partyId: senderPartyId,
            description: input.note ?? 'Private synthetic note',
            tags: { app_operation_id: input.operation ?? operationId },
          },
        },
      }),
    );
    const signedAt = new Date();
    return verifyNaturalEvent(
      raw,
      new Headers({
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
        'webhook-signature': new Webhook(secret).sign(id, signedAt, raw),
      }),
      [secret],
    );
  }
  const rows = () =>
    sql<{
      id: string;
      status: string;
      quarantine_reason: string | null;
      payload_ciphertext: string | null;
      payload_hash: string;
      attempts: number;
      conflict_count: number;
      lease_until: Date | null;
    }>`SELECT * FROM natural_webhook_inbox ORDER BY received_at,id`.execute(db);
  it('commits encrypted original bytes and concurrent duplicates only once', async () => {
    const value = event();
    const result = await Promise.all([service.ingest(value), service.ingest(value)]);
    expect(result.filter((r) => !r.duplicate)).toHaveLength(1);
    const saved = (await rows()).rows;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.payload_ciphertext).toMatch(/^v1\./);
    expect(saved[0]?.payload_ciphertext).not.toContain('Private synthetic note');
    expect(saved[0]?.payload_hash).toBe(value.payloadHash);
    expect(saved[0]?.status).toBe('pending');
  });
  it('quarantines divergent bytes under the same signed event ID without overwriting original', async () => {
    const value = event();
    await service.ingest(value);
    await service.ingest(event({ id: value.event.id, note: 'Changed bytes' }));
    const saved = (await rows()).rows[0];
    expect(saved?.quarantine_reason).toBe('event_payload_conflict');
    expect(saved?.conflict_count).toBe(1);
    expect(saved?.payload_hash).toBe(value.payloadHash);
    const wake = vi.fn();
    expect(await service.processOne(wake)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });
  it('only emits canonical-read hints and never changes payment status', async () => {
    await service.ingest(event());
    const wake = vi.fn().mockResolvedValue(1);
    expect(await service.processOne(wake)).toBe(true);
    expect(wake).toHaveBeenCalledExactlyOnceWith({
      kind: 'send',
      operationId,
      providerId: paymentId,
    });
    expect((await rows()).rows[0]?.status).toBe('processed');
    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM natural_sandbox_sends WHERE id=${sendId}::uuid`.execute(db)
      ).rows[0]?.status,
    ).toBe('PROCESSING');
  });
  it('accepts the separate recipient actor event for the same saved payment', async () => {
    await service.ingest(event({ source: recipientPartyId }));
    const wake = vi.fn().mockResolvedValue(1);
    await service.processOne(wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });
  it('uses a saved operation for an unknown send without trusting the webhook payment ID', async () => {
    await sql`UPDATE natural_sandbox_sends SET provider_payment_id=NULL WHERE id=${sendId}::uuid`.execute(
      db,
    );
    await service.ingest(event({ resourceId: providerId('pay') }));
    const wake = vi.fn().mockResolvedValue(1);
    await service.processOne(wake);
    expect(wake).toHaveBeenCalledExactlyOnceWith({ kind: 'send', operationId });
  });
  it('never replaces a known payment ID with another resource carrying copied metadata', async () => {
    await service.ingest(event({ resourceId: providerId('pay') }));
    const wake = vi.fn().mockResolvedValue(1);
    await service.processOne(wake);
    expect(wake).not.toHaveBeenCalled();
    expect((await rows()).rows[0]?.status).toBe('pending');
  });
  it('quarantines unbound parties and inconsistent actor snapshots', async () => {
    await service.ingest(event({ source: providerId('pty') }));
    expect((await rows()).rows[0]?.quarantine_reason).toBe('event_source_mismatch');
    const unknown = providerId('pty');
    await service.ingest(event({ source: unknown, sender: unknown }));
    expect((await rows()).rows.some((r) => r.quarantine_reason === 'unknown_source_party')).toBe(
      true,
    );
  });
  it('rejects another locally known customer with copied operation metadata', async () => {
    await service.ingest(event({ source: unrelatedPartyId, sender: unrelatedPartyId }));
    const wake = vi.fn().mockResolvedValue(1);
    await service.processOne(wake);
    expect(wake).not.toHaveBeenCalled();
  });
  it('separates the configured platform and agent from other local connections', async () => {
    const other = new NaturalWebhookInboxService(
      db,
      { ...options, platformPartyId: providerId('pty') },
      () => now,
    );
    await other.ingest(event());
    expect((await rows()).rows[0]?.quarantine_reason).toBe('unknown_source_party');
    expect(await service.processOne(vi.fn())).toBe(false);
  });
  it('quarantines signed unknown event types for investigation', async () => {
    await service.ingest(event({ type: 'payment.new_type' }));
    expect((await rows()).rows[0]?.quarantine_reason).toBe('unsupported_event_type');
  });
  it('isolates production events and never schedules them on the sandbox worker', async () => {
    const value = event();
    await service.ingest(value);
    const live = new NaturalWebhookInboxService(
      db,
      { ...options, environment: 'production' },
      () => now,
    );
    await live.ingest(value);
    const wake = vi.fn();
    expect((await rows()).rows).toHaveLength(2);
    expect(
      (await rows()).rows.some((r) => r.quarantine_reason === 'production_processing_disabled'),
    ).toBe(true);
    expect(await live.processOne(wake)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });
  it('matches deposits only by the saved canonical transfer and exact party', async () => {
    await service.ingest(event({ type: 'deposit.completed' }));
    const wake = vi.fn().mockResolvedValue(1);
    await service.processOne(wake);
    expect(wake).toHaveBeenCalledExactlyOnceWith({
      kind: 'funding',
      operationId: depositOperationId,
      providerId: fundingId,
    });
    await service.ingest(
      event({
        type: 'deposit.completed',
        resourceId: providerId('trf'),
        operation: depositOperationId,
      }),
    );
    await service.processOne(wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });
  it('retries worker failures without losing evidence then quarantines exhausted hints', async () => {
    await service.ingest(event());
    const wake = vi.fn().mockRejectedValue(new Error('Private failure detail'));
    for (let i = 0; i < 12; i++) {
      expect(await service.processOne(wake)).toBe(true);
      now = new Date(now.getTime() + 300001);
    }
    expect((await rows()).rows[0]?.quarantine_reason).toBe('reconciliation_target_unavailable');
    expect((await rows()).rows[0]?.attempts).toBe(12);
  });
  it('leases concurrent work and fences a stale completion after reclaim', async () => {
    await service.ingest(event());
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = service.processOne(async () => {
      started();
      await held;
      return 0;
    });
    await signal;
    expect(await service.processOne(vi.fn())).toBe(false);
    now = new Date(now.getTime() + 61000);
    expect(await service.processOne(async () => 1)).toBe(true);
    release();
    await first;
    expect((await rows()).rows[0]?.status).toBe('processed');
  });
  it('runs processing without the web encryption key and fails closed on ingestion', async () => {
    await service.ingest(event());
    const worker = new NaturalWebhookInboxService(
      db,
      { environment: 'sandbox', platformPartyId, agentId },
      () => now,
    );
    expect(await worker.processOne(async () => 1)).toBe(true);
    await expect(worker.ingest(event())).rejects.toThrow('NATURAL_WEBHOOK_NOT_CONFIGURED');
  });
  it('expires encrypted bodies while retaining durable duplicate identity', async () => {
    const value = event();
    await service.ingest(value);
    now = new Date(now.getTime() + 31 * 86400_000);
    expect(await service.purgeExpiredPayloads()).toBe(1);
    expect((await rows()).rows[0]?.payload_ciphertext).toBeNull();
    expect(await service.ingest(value)).toEqual({ duplicate: true, quarantined: false });
    expect((await rows()).rows).toHaveLength(1);
  });
  function acceptance(
    input: { agent?: string; platform?: string; source?: string; customer?: string } = {},
  ) {
    const id = providerId('evt');
    const invitationId = providerId('adi');
    const customer = input.customer ?? senderPartyId;
    const raw = Buffer.from(
      JSON.stringify({
        id,
        object: 'event',
        type: 'agent_delegation_invitation.accepted',
        sourcePartyId: input.source ?? customer,
        resourceType: 'agent_delegation_invitation',
        resourceId: invitationId,
        createdAt: initialNow.toISOString(),
        data: {
          object: {
            invitationId,
            agentId: input.agent ?? agentId,
            delegateePartyId: input.platform ?? platformPartyId,
            delegatorPartyId: customer,
            status: 'accepted',
            customerEmail: 'private-synthetic@example.invalid',
          },
        },
      }),
    );
    const signedAt = new Date();
    return verifyNaturalEvent(
      raw,
      new Headers({
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
        'webhook-signature': new Webhook(secret).sign(id, signedAt, raw),
      }),
      [secret],
    );
  }
  it('queues only production acceptance hints and fetches no snapshot data in the worker', async () => {
    const live = new NaturalWebhookInboxService(
      db,
      { ...options, environment: 'production' },
      () => now,
    );
    const value = acceptance();
    await live.ingest(value);
    expect((await rows()).rows[0]?.status).toBe('pending');
    const worker = new NaturalWebhookInboxService(
      db,
      { environment: 'production', platformPartyId, agentId },
      () => now,
    );
    const reconcile = vi.fn().mockResolvedValue('processed');
    expect(await worker.processAcceptanceOne(reconcile)).toBe(true);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith({
      eventId: value.event.id,
      invitationId: value.event.resourceId,
    });
    expect((await rows()).rows[0]?.status).toBe('processed');
    expect(await worker.processOne(vi.fn())).toBe(false);
  });
  it('quarantines accepted invitations for another agent/platform or inconsistent source', async () => {
    const live = new NaturalWebhookInboxService(
      db,
      { ...options, environment: 'production' },
      () => now,
    );
    for (const input of [
      { agent: providerId('agt') },
      { platform: providerId('pty') },
      { source: unrelatedPartyId },
      { customer: platformPartyId },
    ])
      await live.ingest(acceptance(input));
    expect(
      (await rows()).rows.every((row) => row.quarantine_reason === 'acceptance_binding_mismatch'),
    ).toBe(true);
    const reconcile = vi.fn();
    expect(await live.processAcceptanceOne(reconcile)).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('does not treat a signed acceptance as canonical verified connection evidence', async () => {
    const live = new NaturalWebhookInboxService(
      db,
      { ...options, environment: 'production' },
      () => now,
    );
    await live.ingest(acceptance());
    await live.processAcceptanceOne(async () => 'retry');
    expect((await rows()).rows[0]?.status).toBe('pending');
    now = new Date(now.getTime() + 3000);
    await live.processAcceptanceOne(async () => 'quarantined');
    expect((await rows()).rows[0]?.quarantine_reason).toBe('acceptance_binding_unverified');
  });
  it('never lets sandbox acceptance events enter the production connection processor', async () => {
    await service.ingest(acceptance());
    expect((await rows()).rows[0]?.quarantine_reason).toBe('unsupported_event_type');
    const reconcile = vi.fn();
    expect(await service.processAcceptanceOne(reconcile)).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('keeps acceptance work leased through bounded canonical reads and rejects expired completion', async () => {
    const live = new NaturalWebhookInboxService(
      db,
      { ...options, environment: 'production' },
      () => now,
    );
    await live.ingest(acceptance());
    await live.processAcceptanceOne(async () => {
      now = new Date(now.getTime() + 75000);
      return 'processed';
    });
    expect((await rows()).rows[0]?.status).toBe('processed');
    await sql`DELETE FROM natural_webhook_inbox`.execute(db);
    await live.ingest(acceptance());
    await live.processAcceptanceOne(async () => {
      now = new Date(now.getTime() + 121000);
      return 'processed';
    });
    expect((await rows()).rows[0]?.status).toBe('processing');
    expect(await live.processAcceptanceOne(async () => 'processed')).toBe(true);
    expect((await rows()).rows[0]?.status).toBe('processed');
  });
});
