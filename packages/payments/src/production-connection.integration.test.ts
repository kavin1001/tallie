import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@tallie/db';
import type { AccountPrincipal } from '@tallie/identity';
import { migrate } from '../../db/src/migrate';
import { PhoneVault } from '../../channels/src/phone-vault';
import { NaturalProviderError } from '../../natural/src/errors';
import type { PaymentDatabase } from './schema';
import {
  ProductionConnectionService,
  type ProductionConnectionGateway,
} from './production-connection';

config({ quiet: true });
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const platformPartyId = id('pty');
const agentId = id('agt');
const initialTime = new Date('2026-09-26T12:00:00Z');
const vault = new PhoneVault('31'.repeat(32));
const settings = {
  enabled: true,
  environment: 'production' as const,
  platformPartyId,
  agentId,
  perTransactionLimitMinor: 10000,
};

describe('production hosted activation authority and durability', () => {
  const schema = `tallie_production_connection_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = initialTime;
  let nextPhone = 2000;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Local PostgreSQL required.');
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
  async function fixture() {
    const phone = `+1202555${nextPhone++}`;
    const actor: AccountPrincipal = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      phoneHash: vault.lookup(phone),
      displayName: 'Fixture',
    };
    await sql`INSERT INTO auth_user(id,name,email)VALUES(${actor.userId}::uuid,'Fixture',${`${actor.userId}@test.invalid`})`.execute(
      db,
    );
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at)
      VALUES(${actor.userId}::uuid,${actor.phoneHash},${vault.seal(phone, `${actor.userId}:phone`)},'••• 2000',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at)
      VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,${randomUUID()},${new Date(now.getTime() + 86_400_000)},'passkey',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_passkey(id,user_id,public_key,credential_id,counter,device_type,backed_up)
      VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'fixture',${randomUUID()},0,'singleDevice',false)`.execute(
      db,
    );
    const invitationId = id('adi');
    const customerPartyId = id('pty');
    const accepted = {
      customerPartyId,
      delegationId: id('dlg'),
      agentId,
      perTransactionLimitMinor: 10000,
      invitationAccepted: true as const,
      moneyMovementEnabled: false as const,
    };
    const wallet = {
      id: id('wal'),
      partyId: customerPartyId,
      status: 'active',
      walletType: 'standard',
      agentDefault: true,
      currency: 'USD' as const,
    };
    const invite = {
      invitationId,
      url: `https://www.natural.com/connect/${invitationId}`,
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    };
    const gateway: ProductionConnectionGateway = {
      createInvitation: vi.fn(async () => invite),
      verifyAcceptedConnection: vi.fn(async () => accepted),
      getReceivingWallet: vi.fn(async () => wallet),
    };
    const service = new ProductionConnectionService(db, gateway, vault, settings, () => now);
    const row = async () =>
      (
        await sql<{
          status: string;
          invitation_url_ciphertext: string | null;
          return_state_hash: string;
          invitation_id: string | null;
          invite_operation_id: string;
          invite_idempotency_key: string;
          customer_party_id: string | null;
          wallet_id: string | null;
          lease_token: string | null;
          generation: number;
        }>`SELECT * FROM natural_production_connections WHERE account_id=${actor.userId}::uuid`.execute(
          db,
        )
      ).rows[0];
    return {
      actor,
      phone,
      invitationId,
      invite,
      accepted,
      wallet,
      gateway,
      service,
      row,
      hint: { eventId: id('evt'), invitationId },
    };
  }

  it('gets the phone only from the account vault, encrypts URL, hashes state and sends once', async () => {
    const f = await fixture();
    expect((await f.service.start(f.actor)).connection?.invitationUrl).toBe(f.invite.url);
    await f.service.start(f.actor);
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    const input = vi.mocked(f.gateway.createInvitation).mock.calls[0]![0];
    expect(input.verifiedPhone).toBe(f.phone);
    const saved = (await f.row())!;
    expect(saved.invitation_url_ciphertext).not.toContain(f.invite.url);
    expect(saved.return_state_hash).not.toBe(input.returnState);
    expect(input.operation).toEqual({
      instanceId: saved.invite_operation_id,
      idempotencyKey: saved.invite_idempotency_key,
    });
    expect(saved.customer_party_id).toBeNull();
    expect((await f.service.state(f.actor)).moneyMovementEnabled).toBe(false);
  });

  it('serializes concurrent starts without holding account locks during provider work', async () => {
    const f = await fixture();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.gateway.createInvitation).mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.invite;
    });
    const first = f.service.start(f.actor);
    await entered;
    expect((await f.service.start(f.actor)).connection?.status).toBe('inviting');
    await db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM natural_production_connections WHERE account_id=${f.actor.userId}::uuid FOR UPDATE NOWAIT`.execute(
        tx,
      );
    });
    release();
    await first;
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('never retries an unknown production invitation under either the old or a new key', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.createInvitation).mockRejectedValue(new Error('unknown upstream result'));
    expect((await f.service.start(f.actor)).connection?.status).toBe('unknown');
    const original = await f.row();
    now = new Date(now.getTime() + 60_000);
    expect((await f.service.start(f.actor)).connection?.status).toBe('unknown');
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    expect((await f.row())?.invite_operation_id).toBe(original?.invite_operation_id);
  });

  it.each(['recovery', 'phone_demo', 'onboarding'])(
    'rejects %s assurance before any provider operation',
    async (assurance) => {
      const f = await fixture();
      await sql`UPDATE auth_session SET assurance_kind=${assurance} WHERE id=${f.actor.sessionId}::uuid`.execute(
        db,
      );
      await expect(f.service.start(f.actor)).rejects.toMatchObject({
        code: 'RECENT_PASSKEY_REQUIRED',
      });
      expect(f.gateway.createInvitation).not.toHaveBeenCalled();
      expect(await f.row()).toBeUndefined();
    },
  );

  it('requires a fresh valid passkey and an existing credential', async () => {
    const f = await fixture();
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    await expect(f.service.start(f.actor)).rejects.toMatchObject({
      code: 'RECENT_PASSKEY_REQUIRED',
    });
    now = initialTime;
    await sql`DELETE FROM auth_passkey WHERE user_id=${f.actor.userId}::uuid`.execute(db);
    await expect(f.service.start(f.actor)).rejects.toMatchObject({
      code: 'RECENT_PASSKEY_REQUIRED',
    });
    expect(f.gateway.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects a phone ciphertext that does not match the persisted account binding', async () => {
    const f = await fixture();
    await sql`UPDATE identity_phone_bindings SET phone_ciphertext=${vault.seal('+12025559999', `${f.actor.userId}:phone`)}
      WHERE user_id=${f.actor.userId}::uuid`.execute(db);
    await expect(f.service.start(f.actor)).rejects.toMatchObject({ code: 'PHONE_BINDING_CHANGED' });
    expect(f.gateway.createInvitation).not.toHaveBeenCalled();
  });

  it('does not disclose another account invitation or accept an account-swapped principal', async () => {
    const first = await fixture();
    const second = await fixture();
    await first.service.start(first.actor);
    expect((await second.service.state(second.actor)).connection).toBeNull();
    await expect(
      first.service.state({ ...first.actor, userId: second.actor.userId }),
    ).rejects.toMatchObject({ code: 'RECENT_PASSKEY_REQUIRED' });
  });

  it('does not publish an untrusted redirect returned by a provider adapter', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.createInvitation).mockResolvedValue({
      ...f.invite,
      url: 'https://example.com/steal',
    });
    expect((await f.service.start(f.actor)).connection?.status).toBe('unknown');
    expect((await f.row())?.invitation_url_ciphertext).toBeNull();
  });

  it('keeps navigation return state separate from acceptance evidence', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    const state = vi.mocked(f.gateway.createInvitation).mock.calls[0]![0].returnState;
    expect(await f.service.matchReturn(f.actor, state)).toBe(true);
    expect(await f.service.matchReturn(f.actor, 'A'.repeat(43))).toBe(false);
    expect((await f.row())?.status).toBe('pending');
    expect(f.gateway.verifyAcceptedConnection).not.toHaveBeenCalled();
    const second = await fixture();
    expect(await second.service.matchReturn(second.actor, state)).toBe(false);
  });

  it('connects only after canonical accepted-event, current grants and owned wallet checks', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    // The maintenance role deliberately has no phone or invitation decryption key.
    const worker = new ProductionConnectionService(db, f.gateway, null, settings, () => now);
    expect(await worker.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledExactlyOnceWith({
      ...f.hint,
      perTransactionLimitMinor: 10000,
    });
    expect(f.gateway.getReceivingWallet).toHaveBeenCalledExactlyOnceWith(
      f.accepted.customerPartyId,
    );
    const saved = (await f.row())!;
    expect(saved.status).toBe('connected');
    expect(saved.customer_party_id).toBe(f.accepted.customerPartyId);
    expect(saved.wallet_id).toBe(f.wallet.id);
    const state = await f.service.state(f.actor);
    expect(state.moneyMovementEnabled).toBe(false);
    expect(state.connection?.invitationUrl).toBeNull();
    expect(JSON.stringify(state)).not.toContain(f.accepted.customerPartyId);
    expect(await worker.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(1);
  });

  it('preserves a create-response race for retry and quarantines an invalid resource identifier', async () => {
    const f = await fixture();
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    expect(await f.service.reconcileAcceptedInvitation({ ...f.hint, invitationId: 'wrong' })).toBe(
      'quarantined',
    );
    expect(f.gateway.verifyAcceptedConnection).not.toHaveBeenCalled();
  });

  it.each(['agent', 'platform', 'wallet', 'agentDefault'] as const)(
    'blocks an unexpected canonical %s binding',
    async (mismatch) => {
      const f = await fixture();
      await f.service.start(f.actor);
      if (mismatch === 'agent')
        vi.mocked(f.gateway.verifyAcceptedConnection).mockResolvedValue({
          ...f.accepted,
          agentId: id('agt'),
        });
      if (mismatch === 'platform')
        vi.mocked(f.gateway.verifyAcceptedConnection).mockResolvedValue({
          ...f.accepted,
          customerPartyId: platformPartyId,
        });
      if (mismatch === 'wallet')
        vi.mocked(f.gateway.getReceivingWallet).mockResolvedValue({
          ...f.wallet,
          partyId: id('pty'),
        });
      if (mismatch === 'agentDefault')
        vi.mocked(f.gateway.getReceivingWallet).mockResolvedValue({
          ...f.wallet,
          agentDefault: false,
        });
      expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('quarantined');
      expect((await f.row())?.status).toBe('blocked');
      expect((await f.row())?.customer_party_id).toBeNull();
    },
  );

  it.each(['binding_mismatch', 'invalid_response'] as const)(
    "quarantines the provider adapter's canonical %s failure without another invitation",
    async (reason) => {
      const f = await fixture();
      await f.service.start(f.actor);
      vi.mocked(f.gateway.verifyAcceptedConnection).mockRejectedValueOnce(
        new NaturalProviderError(reason, 'not_submitted'),
      );
      expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('quarantined');
      expect((await f.row())?.status).toBe('blocked');
      expect((await f.row())?.customer_party_id).toBeNull();
      expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('quarantined');
      expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(1);
      expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    },
  );

  it('retries provider transport and authorization outages without quarantining the invitation', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    for (const error of [
      new NaturalProviderError('transport', 'not_submitted'),
      new NaturalProviderError('http', 'not_submitted', 401),
    ]) {
      vi.mocked(f.gateway.verifyAcceptedConnection).mockRejectedValueOnce(error);
      expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
      expect((await f.row())?.status).toBe('pending');
    }
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('does not quarantine from a stale worker failure after its lease expires', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    vi.mocked(f.gateway.verifyAcceptedConnection).mockImplementationOnce(async () => {
      now = new Date(now.getTime() + 90_001);
      throw new NaturalProviderError('binding_mismatch', 'not_submitted');
    });
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    expect((await f.row())?.status).toBe('verifying');
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    expect((await f.row())?.status).toBe('connected');
  });

  it('can retry canonical reads after transport or unavailable wallet evidence', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    vi.mocked(f.gateway.verifyAcceptedConnection).mockRejectedValueOnce(new Error('read failure'));
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    expect((await f.row())?.status).toBe('pending');
    vi.mocked(f.gateway.getReceivingWallet).mockResolvedValueOnce({ ...f.wallet, currency: null });
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('refuses activation after the account phone binding changes, including during canonical I/O', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    vi.mocked(f.gateway.verifyAcceptedConnection).mockImplementation(async () => {
      await sql`UPDATE identity_phone_bindings SET phone_hash='changed-binding' WHERE user_id=${f.actor.userId}::uuid`.execute(
        db,
      );
      return f.accepted;
    });
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('quarantined');
    expect((await f.row())?.customer_party_id).toBeNull();
    expect((await f.row())?.status).toBe('blocked');
  });

  it('fences a stale canonical worker after lease expiry and prevents a second conflicting event', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.gateway.verifyAcceptedConnection).mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.accepted;
    });
    const first = f.service.reconcileAcceptedInvitation(f.hint);
    await entered;
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    now = new Date(now.getTime() + 91_000);
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('processed');
    release();
    expect(await first).toBe('retry');
    expect((await f.row())?.status).toBe('connected');
    expect(await f.service.reconcileAcceptedInvitation({ ...f.hint, eventId: id('evt') })).toBe(
      'quarantined',
    );
  });

  it('hides an expired invitation without creating a replacement', async () => {
    const f = await fixture();
    await f.service.start(f.actor);
    now = new Date(now.getTime() + 86_400_001);
    await sql`UPDATE auth_session SET expires_at=${new Date(now.getTime() + 86_400_000)},assurance_at=${now}
      WHERE id=${f.actor.sessionId}::uuid`.execute(db);
    const state = await f.service.start(f.actor);
    expect(state.connection?.status).toBe('expired');
    expect(state.connection?.invitationUrl).toBeNull();
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  async function blockedFixture(reason = 'acceptance_binding_unverified') {
    const f = await fixture();
    await f.service.start(f.actor);
    vi.mocked(f.gateway.verifyAcceptedConnection).mockRejectedValueOnce(
      new NaturalProviderError('binding_mismatch', 'not_submitted'),
    );
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('quarantined');
    await sql`INSERT INTO natural_webhook_inbox
      (id,environment,platform_party_id,agent_id,event_id,event_type,source_party_id,
       resource_type,resource_id,payload_hash,event_created_at,signed_at,payload_expires_at,
       status,quarantine_reason,conflict_count)
      VALUES(${randomUUID()}::uuid,'production',${platformPartyId},${agentId},${f.hint.eventId},
        'agent_delegation_invitation.accepted',${f.accepted.customerPartyId},
        'agent_delegation_invitation',${f.invitationId},${'a'.repeat(64)},${now},${now},
        ${new Date(now.getTime() + 86400_000)},'quarantined',${reason},
        ${reason === 'event_payload_conflict' ? 1 : 0})`.execute(db);
    return f;
  }

  it('refreshes only saved acceptance and leaves a pending invitation intact without resending', async () => {
    const f = await fixture();
    expect((await f.service.refresh(f.actor)).connection).toBeNull();
    expect(f.gateway.createInvitation).not.toHaveBeenCalled();
    await f.service.start(f.actor);
    expect((await f.service.refresh(f.actor)).connection?.status).toBe('pending');
    expect(f.gateway.verifyAcceptedConnection).not.toHaveBeenCalled();
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('recovers the same blocked acceptance through canonical checks and records the old quarantine', async () => {
    const f = await blockedFixture();
    const original = await f.row();
    const state = await f.service.refresh(f.actor);
    expect(state.connection?.status).toBe('connected');
    expect(state.moneyMovementEnabled).toBe(false);
    expect(await f.row()).toMatchObject({
      invitation_id: original!.invitation_id,
      invite_operation_id: original!.invite_operation_id,
      customer_party_id: f.accepted.customerPartyId,
      wallet_id: f.wallet.id,
    });
    expect(f.gateway.createInvitation).toHaveBeenCalledTimes(1);
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenLastCalledWith({
      ...f.hint,
      perTransactionLimitMinor: 10000,
    });
    const audit = await sql<{
      previous_status: string;
      previous_quarantine_reason: string;
      result: string;
      completed_at: Date;
    }>`
      SELECT previous_status,previous_quarantine_reason,result,completed_at
      FROM natural_production_connection_rechecks WHERE event_id=${f.hint.eventId}`.execute(db);
    expect(audit.rows).toEqual([
      {
        previous_status: 'blocked',
        previous_quarantine_reason: 'acceptance_binding_unverified',
        result: 'processed',
        completed_at: now,
      },
    ]);
    expect(
      (
        await sql<{ status: string; quarantine_reason: string | null }>`
      SELECT status,quarantine_reason FROM natural_webhook_inbox WHERE event_id=${f.hint.eventId}`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ status: 'processed', quarantine_reason: null }]);
    await f.service.refresh(f.actor);
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(2);
  });

  it('keeps invalid grants blocked and limits repeated canonical rechecks', async () => {
    const f = await blockedFixture();
    vi.mocked(f.gateway.verifyAcceptedConnection).mockResolvedValue({
      ...f.accepted,
      agentId: id('agt'),
    });
    expect((await f.service.refresh(f.actor)).connection?.status).toBe('blocked');
    expect((await f.service.refresh(f.actor)).connection?.status).toBe('blocked');
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(2);
    expect(f.gateway.getReceivingWallet).not.toHaveBeenCalled();
    expect((await f.row())?.customer_party_id).toBeNull();
    now = new Date(now.getTime() + 15_000);
    await f.service.refresh(f.actor);
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent refresh calls using the same fenced lease as the worker', async () => {
    const f = await blockedFixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(f.gateway.verifyAcceptedConnection).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.accepted;
    });
    const first = f.service.refresh(f.actor);
    await started;
    expect((await f.service.refresh(f.actor)).connection?.status).toBe('verifying');
    expect(await f.service.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    release();
    expect((await first).connection?.status).toBe('connected');
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(2);
  });

  it('does not let another account or an invalid session retry the blocked customer', async () => {
    const f = await blockedFixture();
    const other = await fixture();
    expect((await f.service.refresh(other.actor)).connection).toBeNull();
    await expect(
      f.service.refresh({ ...f.actor, sessionId: other.actor.sessionId }),
    ).rejects.toMatchObject({ code: 'RECENT_PASSKEY_REQUIRED' });
    expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(1);
    expect((await f.row())?.status).toBe('blocked');
  });

  it.each(['event_payload_conflict', 'acceptance_binding_mismatch', 'unsupported_event_type'])(
    'cannot dismiss a %s quarantine with the refresh button',
    async (reason) => {
      const f = await blockedFixture(reason);
      expect((await f.service.refresh(f.actor)).connection?.status).toBe('blocked');
      expect(f.gateway.verifyAcceptedConnection).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses activation if a conflicting delivery arrives during canonical reads', async () => {
    const f = await blockedFixture();
    vi.mocked(f.gateway.getReceivingWallet).mockImplementationOnce(async () => {
      await sql`UPDATE natural_webhook_inbox SET quarantine_reason='event_payload_conflict',conflict_count=1
        WHERE event_id=${f.hint.eventId}`.execute(db);
      return f.wallet;
    });
    expect((await f.service.refresh(f.actor)).connection?.status).toBe('blocked');
    expect((await f.row())?.customer_party_id).toBeNull();
    expect(
      (
        await sql<{ quarantine_reason: string }>`SELECT quarantine_reason FROM natural_webhook_inbox
      WHERE event_id=${f.hint.eventId}`.execute(db)
      ).rows[0]?.quarantine_reason,
    ).toBe('event_payload_conflict');
  });

  it('fails closed while activation is disabled', async () => {
    const f = await fixture();
    const disabled = new ProductionConnectionService(
      db,
      f.gateway,
      vault,
      { ...settings, enabled: false },
      () => now,
    );
    await expect(disabled.start(f.actor)).rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    await expect(disabled.refresh(f.actor)).rejects.toMatchObject({
      code: 'CONNECTION_UNAVAILABLE',
    });
    expect(await disabled.reconcileAcceptedInvitation(f.hint)).toBe('retry');
    expect((await disabled.state(f.actor)).available).toBe(false);
    expect(f.gateway.createInvitation).not.toHaveBeenCalled();
  });
});
