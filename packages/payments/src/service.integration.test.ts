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
  type SandboxCustomer,
  type SandboxInvitation,
  type SandboxOnboardingGateway,
  type SandboxWallet,
} from './gateway';
import type { PaymentDatabase } from './schema';
import { SandboxOnboardingService } from './service';

config({ quiet: true });
const permissions = ['party.read', 'wallets.read', 'wallets.balance'];
const providerConfig = {
  enabled: true,
  environment: 'sandbox' as const,
  platformPartyId: 'pty_platform',
  agentId: 'agt_tallie',
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
    id: `invite_${randomUUID()}`,
    agentId: providerConfig.agentId,
    customerPartyId: null,
    status: 'PENDING',
    effectiveStatus: 'PENDING',
    permissions: [...permissions],
  };
  const accepted: SandboxInvitation = {
    ...invitation,
    customerPartyId,
    status: 'ACCEPTED',
    effectiveStatus: 'ACCEPTED',
  };
  const customer: SandboxCustomer = {
    id: customerPartyId,
    delegation: { id: `dlg_${randomUUID()}`, status: 'ACTIVE', permissions: [...permissions] },
    agents: [{ id: providerConfig.agentId, status: 'ACTIVE', permissions: [...permissions] }],
  };
  const wallets: SandboxWallet[] = [
    {
      id: `wal_${randomUUID()}`,
      partyId: customerPartyId,
      status: 'active',
      walletType: 'standard',
      balance: { available: '9500', total: '10000', currency: 'USD' },
    },
  ];
  const response = { customerPartyId, invitations: [invitation] };
  const gateway = {
    createInvitation: vi
      .fn<SandboxOnboardingGateway['createInvitation']>()
      .mockImplementation(async () => structuredClone(response)),
    acceptInvitation: vi
      .fn<SandboxOnboardingGateway['acceptInvitation']>()
      .mockImplementation(async () => structuredClone(accepted)),
    getCustomer: vi
      .fn<SandboxOnboardingGateway['getCustomer']>()
      .mockImplementation(async () => structuredClone(customer)),
    listWallets: vi
      .fn<SandboxOnboardingGateway['listWallets']>()
      .mockImplementation(async () => structuredClone(wallets)),
  };
  return { gateway, response, invitation, accepted, customer, wallets, customerPartyId };
}

describe('durable Natural sandbox onboarding PostgreSQL boundaries', () => {
  const schema = `tallie_sandbox_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = new Date();

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
    now = new Date();
  });

  async function account(assurance = 'passkey', phoneDemo = false): Promise<AccountPrincipal> {
    const actor = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      phoneHash: randomUUID(),
      displayName: 'Sandbox tester',
    };
    await sql`INSERT INTO auth_user(id,name,email,phone_demo) VALUES(${actor.userId}::uuid,${actor.displayName},${`${actor.userId}@test.invalid`},${phoneDemo})`.execute(
      db,
    );
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at) VALUES(${actor.userId}::uuid,${actor.phoneHash},'test-ciphertext','••• 0000',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,${randomUUID()},${new Date(now.getTime() + 30 * 86400_000)},${assurance},${now})`.execute(
      db,
    );
    return actor;
  }
  async function fixture() {
    const actor = await account();
    const fake = fakeGateway();
    return {
      actor,
      ...fake,
      service: new SandboxOnboardingService(db, fake.gateway, providerConfig, () => now),
    };
  }
  const stored = (actor: AccountPrincipal) =>
    db
      .selectFrom('natural_sandbox_connections')
      .selectAll()
      .where('account_id', '=', actor.userId)
      .executeTakeFirstOrThrow();

  it('defaults off and rejects production or write permission configuration', async () => {
    const f = await fixture();
    const disabled = new SandboxOnboardingService(
      db,
      f.gateway,
      { ...providerConfig, enabled: false },
      () => now,
    );
    expect(await disabled.state(f.actor)).toMatchObject({
      available: false,
      connection: null,
      moneyMovementEnabled: false,
    });
    await expect(disabled.start(f.actor)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(f.gateway.createInvitation).not.toHaveBeenCalled();
    expect(
      () =>
        new SandboxOnboardingService(db, f.gateway, {
          ...providerConfig,
          environment: 'production' as 'sandbox',
        }),
    ).toThrow();
    expect(
      () =>
        new SandboxOnboardingService(db, f.gateway, {
          ...providerConfig,
          permissions: ['payments.create'],
        }),
    ).toThrow();
  });

  it('persists setup identity before dispatch and exposes only local account and balance IDs', async () => {
    const f = await fixture();
    f.gateway.createInvitation.mockImplementationOnce(async (input) => {
      const row = await stored(f.actor);
      expect(row.status).toBe('inviting');
      expect(row.invite_idempotency_key).toBe(input.idempotencyKey);
      expect(row.invite_operation_id).toBe(input.operationId);
      expect(row.first_submission_at).not.toBeNull();
      return f.response;
    });
    const result = await f.service.start(f.actor);
    expect(result.connection).toMatchObject({
      status: 'connected',
      retryAllowed: false,
      balances: [{ currency: 'USD', availableMinor: '9500', totalMinor: '10000' }],
    });
    expect(result.moneyMovementEnabled).toBe(false);
    for (const secret of [
      f.customerPartyId,
      f.invitation.id,
      f.wallets[0]!.id,
      providerConfig.agentId,
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect((await stored(f.actor)).delegation_id).toBe(f.customer.delegation.id);
    expect(await f.service.start(f.actor)).toEqual(result);
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('isolates other users, spoofed sessions and replaced phone bindings', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    const outsider = await account();
    expect((await f.service.state(outsider)).connection).toBeNull();
    await expect(
      f.service.state({ ...f.actor, sessionId: outsider.sessionId }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(f.service.start({ ...outsider, userId: f.actor.userId })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await sql`UPDATE identity_phone_bindings SET phone_hash=${randomUUID()} WHERE user_id=${f.actor.userId}::uuid`.execute(
      db,
    );
    await expect(f.service.state(f.actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('admits phone demo only with all flags, matching marker and no existing credential', async () => {
    const f = await fixture();
    const actor = await account('phone_demo', true);
    await expect(f.service.start(actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    vi.stubEnv('APP_MODE', 'beta');
    vi.stubEnv('APP_PREVIEW_MODE', 'true');
    vi.stubEnv('IDENTITY_PHONE_DEMO_ENABLED', 'true');
    expect((await f.service.start(actor)).connection?.status).toBe('connected');
    await sql`INSERT INTO auth_passkey(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'test',${randomUUID()},0,'singleDevice',false)`.execute(
      db,
    );
    await expect(f.service.state(actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const unmarked = await account('phone_demo', false);
    await expect(f.service.start(unmarked)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const enrollment = await account('onboarding');
    await expect(f.service.start(enrollment)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it.each(['invite', 'accept'] as const)(
    'retries a lost %s response with identical durable operation identities',
    async (phase) => {
      const f = await fixture();
      if (phase === 'invite')
        f.gateway.createInvitation.mockRejectedValueOnce(new Error('lost transport'));
      else f.gateway.acceptInvitation.mockRejectedValueOnce(new Error('lost transport'));
      expect((await f.service.start(f.actor)).connection).toMatchObject({
        status: 'unknown',
        retryAllowed: true,
      });
      const unknown = await stored(f.actor);
      await f.service.start(f.actor);
      expect(
        phase === 'invite' ? f.gateway.createInvitation : f.gateway.acceptInvitation,
      ).toHaveBeenCalledTimes(1);
      expect((await f.service.retry(f.actor)).connection?.status).toBe('connected');
      const retried = await stored(f.actor);
      expect(retried.invite_idempotency_key).toBe(unknown.invite_idempotency_key);
      expect(retried.accept_idempotency_key).toBe(unknown.accept_idempotency_key);
      const calls =
        phase === 'invite'
          ? f.gateway.createInvitation.mock.calls
          : f.gateway.acceptInvitation.mock.calls;
      expect(calls[1]![0]).toEqual(calls[0]![0]);
    },
  );

  it('does not hold database locks over network or dispatch simultaneous starts twice', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const reply = deferred<typeof f.response>();
    f.gateway.createInvitation.mockImplementationOnce(async () => {
      entered.resolve();
      return reply.promise;
    });
    const pending = f.service.start(f.actor);
    await entered.promise;
    const other = await Promise.all([
      f.service.start(f.actor),
      f.service.retry(f.actor),
      f.service.state(f.actor),
    ]);
    expect(other.every((state) => state.connection?.status === 'inviting')).toBe(true);
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    reply.resolve(f.response);
    expect((await pending).connection?.status).toBe('connected');
  });

  it('fences a late first worker response after lease recovery', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const late = deferred<typeof f.response>();
    f.gateway.createInvitation.mockImplementationOnce(async () => {
      entered.resolve();
      return late.promise;
    });
    const first = f.service.start(f.actor);
    await entered.promise;
    now = new Date(now.getTime() + 31_000);
    expect((await f.service.state(f.actor)).connection?.status).toBe('unknown');
    const recovered = await f.service.retry(f.actor);
    expect(recovered.connection?.status).toBe('connected');
    late.resolve({ ...f.response, customerPartyId: providerConfig.platformPartyId });
    expect((await first).connection?.status).toBe('connected');
    expect((await stored(f.actor)).generation).toBe(2);
    expect(f.gateway.createInvitation.mock.calls[0]![0]).toEqual(
      f.gateway.createInvitation.mock.calls[1]![0],
    );
  });

  it.each([
    'platform',
    'multiple',
    'agent',
    'permission',
    'accepted_customer',
    'accepted_id',
  ] as const)('blocks mismatched %s identity without downstream binding', async (scenario) => {
    const f = await fixture();
    if (scenario === 'platform') f.response.customerPartyId = providerConfig.platformPartyId;
    if (scenario === 'multiple') f.response.invitations.push({ ...f.invitation, id: 'another' });
    if (scenario === 'agent') f.invitation.agentId = 'agt_wrong';
    if (scenario === 'permission') f.invitation.permissions.push('payments.create');
    if (scenario === 'accepted_customer') f.accepted.customerPartyId = 'pty_wrong';
    if (scenario === 'accepted_id') f.accepted.id = 'invite_wrong';
    expect((await f.service.start(f.actor)).connection).toMatchObject({
      status: 'blocked',
      retryAllowed: false,
      balances: [],
    });
    expect(f.gateway.getCustomer).not.toHaveBeenCalled();
    expect((await stored(f.actor)).delegation_id).toBeNull();
  });

  it.each([
    'parent_status',
    'parent_permissions',
    'agent_status',
    'agent_permissions',
    'wrong_customer',
  ] as const)('requires canonical active and authorized customer: %s', async (scenario) => {
    const f = await fixture();
    if (scenario === 'parent_status') f.customer.delegation.status = 'REVOKED';
    if (scenario === 'parent_permissions') f.customer.delegation.permissions = [];
    if (scenario === 'agent_status') f.customer.agents[0]!.status = 'SUSPENDED';
    if (scenario === 'agent_permissions') f.customer.agents[0]!.permissions = [];
    if (scenario === 'wrong_customer') f.customer.id = 'pty_wrong';
    expect((await f.service.start(f.actor)).connection?.status).toBe('blocked');
    expect(f.gateway.listWallets).not.toHaveBeenCalled();
  });

  it('preserves unavailable and signed balances and ignores vault/frozen wallets', async () => {
    const f = await fixture();
    f.wallets[0]!.balance = null;
    f.wallets.push({
      ...f.wallets[0]!,
      id: 'wal_signed',
      balance: { available: '-125', total: '-100', currency: 'USD' },
    });
    f.wallets.push({ ...f.wallets[0]!, id: 'wal_vault', walletType: 'vault' });
    f.wallets.push({ ...f.wallets[0]!, id: 'wal_frozen', status: 'frozen' });
    const result = await f.service.start(f.actor);
    expect(result.connection?.balances).toHaveLength(2);
    expect(result.connection?.balances[0]).toMatchObject({
      availableMinor: null,
      totalMinor: null,
    });
    expect(result.connection?.balances[1]).toMatchObject({
      availableMinor: '-125',
      totalMinor: '-100',
    });
  });

  it('rejects wallets belonging to a different party', async () => {
    const f = await fixture();
    f.wallets[0]!.partyId = providerConfig.platformPartyId;
    expect((await f.service.start(f.actor)).connection).toMatchObject({
      status: 'blocked',
      balances: [],
    });
  });

  it('refreshes canonical access, rate bounds reads and hides balances after revocation', async () => {
    const f = await fixture();
    const first = await f.service.start(f.actor);
    await f.service.refresh(f.actor);
    expect(f.gateway.getCustomer).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 6_000);
    const second = await f.service.refresh(f.actor);
    expect(second.connection?.balances[0]?.id).toBe(first.connection?.balances[0]?.id);
    f.customer.delegation.status = 'REVOKED';
    now = new Date(now.getTime() + 6_000);
    expect((await f.service.refresh(f.actor)).connection).toMatchObject({
      status: 'blocked',
      balances: [],
    });
  });

  it('stops ambiguous mutation retries after 24 hours but permits old-account read retries', async () => {
    const f = await fixture();
    f.gateway.createInvitation.mockRejectedValueOnce(new Error('lost'));
    await f.service.start(f.actor);
    now = new Date(now.getTime() + 24 * 3600_000);
    expect((await f.service.state(f.actor)).connection?.retryAllowed).toBe(false);
    await expect(f.service.retry(f.actor)).rejects.toMatchObject({ code: 'SANDBOX_RETRY_EXPIRED' });
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    const g = await fixture();
    await g.service.start(g.actor);
    now = new Date(now.getTime() + 25 * 3600_000);
    g.gateway.listWallets.mockRejectedValueOnce(new Error('read interrupted'));
    expect((await g.service.refresh(g.actor)).connection).toMatchObject({
      status: 'unknown',
      retryAllowed: true,
    });
    expect((await g.service.retry(g.actor)).connection?.status).toBe('connected');
    expect(g.gateway.createInvitation).toHaveBeenCalledTimes(1);
    expect(g.gateway.getCustomer).toHaveBeenCalledTimes(3);
  });

  it('retains returned evidence but discloses nothing when a session expires during a network call', async () => {
    const f = await fixture();
    f.gateway.listWallets.mockImplementationOnce(async () => {
      await sql`UPDATE auth_session SET expires_at=${new Date(now.getTime() - 1)} WHERE id=${f.actor.sessionId}::uuid`.execute(
        db,
      );
      return f.wallets;
    });
    await expect(f.service.start(f.actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect((await stored(f.actor)).status).toBe('connected');
    await expect(f.service.state(f.actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('stops before the next external mutation if a session is revoked in flight', async () => {
    const f = await fixture();
    f.gateway.createInvitation.mockImplementationOnce(async () => {
      await sql`DELETE FROM auth_session WHERE id=${f.actor.sessionId}::uuid`.execute(db);
      return f.response;
    });
    await expect(f.service.start(f.actor)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect((await stored(f.actor)).invitation_id).toBe(f.invitation.id);
    expect(f.gateway.acceptInvitation).not.toHaveBeenCalled();
  });

  it('distinguishes explicit provider rejection from ambiguous transport failures', async () => {
    const f = await fixture();
    f.gateway.createInvitation.mockRejectedValueOnce(new SandboxGatewayError('DENIED', 'rejected'));
    expect((await f.service.start(f.actor)).connection).toMatchObject({
      status: 'blocked',
      retryAllowed: false,
    });
  });
});
