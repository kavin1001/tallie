import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountPrincipal } from '@tallie/identity';
import { createDatabase } from '@tallie/db';
import { migrate } from '../../db/src/migrate';
import {
  SandboxGatewayError,
  type SandboxOnboardingGateway,
  type SandboxInvitation,
} from './gateway';
import type { PaymentDatabase } from './schema';
import { SANDBOX_SEND_PERMISSIONS, SandboxSendConnectionService } from './send-connection-service';

config({ quiet: true });
const platformPartyId = 'pty_platform';
const agentId = 'agt_tallie';
const permissions = [...SANDBOX_SEND_PERMISSIONS];
const connectionConfig = {
  enabled: true,
  environment: 'sandbox' as const,
  platformPartyId,
  agentId,
  permissions,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeGateway() {
  const customerPartyId = `pty_${randomUUID()}`;
  const invitation: SandboxInvitation = {
    id: `adi_${randomUUID()}`,
    agentId,
    customerPartyId: null,
    status: 'PENDING',
    effectiveStatus: 'PENDING',
    permissions: [...permissions],
  };
  const walletId = `wal_${randomUUID()}`;
  const gateway: SandboxOnboardingGateway = {
    createInvitation: vi.fn(async () => ({
      customerPartyId,
      invitations: [structuredClone(invitation)],
    })),
    acceptInvitation: vi.fn(async () => ({
      ...structuredClone(invitation),
      customerPartyId,
      status: 'ACCEPTED',
      effectiveStatus: 'ACCEPTED',
    })),
    getCustomer: vi.fn(async () => ({
      id: customerPartyId,
      delegation: { id: `dlg_${randomUUID()}`, status: 'ACTIVE', permissions: [...permissions] },
      agents: [{ id: agentId, status: 'ACTIVE', permissions: [...permissions] }],
    })),
    listWallets: vi.fn(async () => [
      {
        id: walletId,
        partyId: customerPartyId,
        status: 'active',
        walletType: 'standard',
        balance: { available: '2400', total: '3000', currency: 'USD' as const },
      },
    ]),
  };
  return { gateway, customerPartyId, walletId };
}

describe('separate sandbox send connection', () => {
  const schema = `tallie_send_connection_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = new Date('2026-09-26T12:00:00.000Z');

  afterEach(() => {
    vi.unstubAllEnvs();
    now = new Date('2026-09-26T12:00:00.000Z');
  });

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

  async function account(assurance = 'passkey'): Promise<AccountPrincipal> {
    const actor = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      phoneHash: randomUUID(),
      displayName: 'Test person',
    };
    await sql`INSERT INTO auth_user(id,name,email,phone_demo) VALUES(${actor.userId}::uuid,'Test person',${`${actor.userId}@test.invalid`},${assurance === 'phone_demo'})`.execute(
      db,
    );
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at) VALUES(${actor.userId}::uuid,${actor.phoneHash},'test-ciphertext','••• 0000',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,${randomUUID()},${new Date(now.getTime() + 86400_000)},${assurance},${now})`.execute(
      db,
    );
    return actor;
  }

  const service = (gateway: SandboxOnboardingGateway) =>
    new SandboxSendConnectionService(db, gateway, connectionConfig, () => now);
  const stored = (actor: AccountPrincipal) =>
    db
      .selectFrom('natural_sandbox_send_connections')
      .selectAll()
      .where('account_id', '=', actor.userId)
      .executeTakeFirstOrThrow();

  it('requires exactly the five configured scopes and a sandbox environment', () => {
    const fake = fakeGateway();
    expect(
      () =>
        new SandboxSendConnectionService(db, fake.gateway, {
          ...connectionConfig,
          permissions: ['party.read', 'payments.create'],
        }),
    ).toThrow();
    expect(
      () =>
        new SandboxSendConnectionService(db, fake.gateway, {
          ...connectionConfig,
          permissions: [...permissions, 'wallets.transfer'],
        }),
    ).toThrow();
    expect(
      () =>
        new SandboxSendConnectionService(db, fake.gateway, {
          ...connectionConfig,
          environment: 'production' as 'sandbox',
        }),
    ).toThrow();
  });

  it('retains a mismatched acceptance for review without touching the legacy connection', async () => {
    const actor = await account();
    const fake = fakeGateway();
    vi.mocked(fake.gateway.createInvitation).mockImplementationOnce(async (input) => {
      const row = await stored(actor);
      expect(row.status).toBe('inviting');
      expect(row.invite_operation_id).toBe(input.operationId);
      expect(row.invite_idempotency_key).toBe(input.idempotencyKey);
      expect(row.permissions).toEqual(permissions);
      return {
        customerPartyId: fake.customerPartyId,
        invitations: [
          {
            id: `adi_${randomUUID()}`,
            agentId,
            customerPartyId: null,
            status: 'PENDING',
            effectiveStatus: 'PENDING',
            permissions: [...permissions],
          },
        ],
      };
    });
    // The fake accept response uses its own invitation ID, so verify a mismatched
    // provider response is retained for review without proceeding to a wallet read.
    const result = await service(fake.gateway).start(actor);
    expect(result.connection?.status).toBe('blocked');
    expect(fake.gateway.listWallets).not.toHaveBeenCalled();
    const row = await stored(actor);
    expect(row.customer_party_id).toBe(fake.customerPartyId);
    expect(row.invite_operation_id).not.toBe(row.accept_operation_id);
    expect(row.invite_idempotency_key).not.toBe(row.accept_idempotency_key);
    expect(
      await db
        .selectFrom('natural_sandbox_connections')
        .select('id')
        .where('account_id', '=', actor.userId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(fake.customerPartyId);
    expect(result.moneyMovementEnabled).toBe(false);
  });

  it('connects on exact canonical grant and exposes only local wallet identifiers', async () => {
    const actor = await account();
    const fake = fakeGateway();
    const result = await service(fake.gateway).start(actor);
    expect(result.connection).toMatchObject({
      status: 'connected',
      balances: [{ currency: 'USD', availableMinor: '2400', totalMinor: '3000' }],
    });
    expect((await stored(actor)).customer_party_id).toBe(fake.customerPartyId);
    expect(JSON.stringify(result)).not.toContain(fake.customerPartyId);
    expect(JSON.stringify(result)).not.toContain(fake.walletId);
    expect(await service(fake.gateway).start(actor)).toEqual(result);
    expect(fake.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('hides balances when the payment-capable delegation is revoked', async () => {
    const actor = await account();
    const fake = fakeGateway();
    const enrollment = service(fake.gateway);
    expect((await enrollment.start(actor)).connection?.status).toBe('connected');
    const row = await stored(actor);
    now = new Date(now.getTime() + 6_000);
    vi.mocked(fake.gateway.getCustomer).mockResolvedValueOnce({
      id: fake.customerPartyId,
      delegation: { id: row.delegation_id!, status: 'REVOKED', permissions: [...permissions] },
      agents: [{ id: agentId, status: 'ACTIVE', permissions: [...permissions] }],
    });
    const result = await enrollment.refresh(actor);
    expect(result.connection?.status).toBe('blocked');
    expect(result.connection?.balances).toEqual([]);
    expect(fake.gateway.listWallets).toHaveBeenCalledTimes(1);
  });

  it('allows marked phone-demo test setup only under the triple preview flag', async () => {
    const phoneDemo = await account('phone_demo');
    const fake = fakeGateway();
    await expect(service(fake.gateway).start(phoneDemo)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    vi.stubEnv('APP_MODE', 'beta');
    vi.stubEnv('APP_PREVIEW_MODE', 'true');
    vi.stubEnv('IDENTITY_PHONE_DEMO_ENABLED', 'true');
    expect((await service(fake.gateway).start(phoneDemo)).connection?.status).toBe('connected');
  });

  it('requires fresh passkey or recovery assurance for established-account grant creation', async () => {
    const oldPasskey = await account();
    const fake = fakeGateway();
    await sql`UPDATE auth_session SET assurance_at=${new Date(now.getTime() - 16 * 60_000)} WHERE id=${oldPasskey.sessionId}::uuid`.execute(
      db,
    );
    await expect(service(fake.gateway).start(oldPasskey)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(fake.gateway.createInvitation).not.toHaveBeenCalled();
  });

  it('retries an ambiguous mutation with its original key, then stops after 24 hours', async () => {
    const actor = await account();
    const fake = fakeGateway();
    vi.mocked(fake.gateway.createInvitation).mockRejectedValueOnce(
      new SandboxGatewayError('NETWORK', 'unknown'),
    );
    const enrollment = service(fake.gateway);
    expect((await enrollment.start(actor)).connection?.status).toBe('unknown');
    const first = await stored(actor);
    expect((await enrollment.retry(actor)).connection?.status).toBe('connected');
    const calls = vi.mocked(fake.gateway.createInvitation).mock.calls;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect((await stored(actor)).invite_idempotency_key).toBe(first.invite_idempotency_key);

    const other = await account();
    const otherGateway = fakeGateway();
    vi.mocked(otherGateway.gateway.createInvitation).mockRejectedValueOnce(
      new SandboxGatewayError('NETWORK', 'unknown'),
    );
    const otherEnrollment = service(otherGateway.gateway);
    await otherEnrollment.start(other);
    now = new Date(now.getTime() + 25 * 60 * 60_000);
    await sql`UPDATE auth_session SET assurance_at=${now}, expires_at=${new Date(now.getTime() + 86400_000)} WHERE id=${other.sessionId}::uuid`.execute(
      db,
    );
    await expect(otherEnrollment.retry(other)).rejects.toMatchObject({
      code: 'SANDBOX_RETRY_EXPIRED',
    });
    expect(otherGateway.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('fences a concurrent second start while the first provider call is unresolved', async () => {
    const actor = await account();
    const fake = fakeGateway();
    const gate = deferred<Awaited<ReturnType<SandboxOnboardingGateway['createInvitation']>>>();
    vi.mocked(fake.gateway.createInvitation).mockReturnValueOnce(gate.promise);
    const enrollment = service(fake.gateway);
    const first = enrollment.start(actor);
    await vi.waitFor(() => expect(fake.gateway.createInvitation).toHaveBeenCalledTimes(1));
    const second = await enrollment.start(actor);
    expect(second.connection?.status).toBe('inviting');
    gate.resolve({
      customerPartyId: fake.customerPartyId,
      invitations: [
        {
          id: `adi_${randomUUID()}`,
          agentId,
          customerPartyId: null,
          status: 'PENDING',
          effectiveStatus: 'PENDING',
          permissions: [...permissions],
        },
      ],
    });
    await first;
    expect(fake.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });
});
