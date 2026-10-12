import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@tallie/db';
import type { AccountPrincipal } from '@tallie/identity';
import { migrate } from '../../db/src/migrate';
import { PhoneVault } from '../../channels/src/phone-vault';
import type { PaymentDatabase } from './schema';
import { OwnerPilotService, type OwnerPilotGateway } from './owner-pilot';
import type { OwnerPilotPayment } from './owner-pilot-contracts';

config({ quiet: true });
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const initialTime = new Date('2026-09-28T12:00:00Z');
const vault = new PhoneVault('32'.repeat(32));

describe('bounded production owner pilot', () => {
  const schema = `tallie_owner_pilot_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<PaymentDatabase>;
  let now = initialTime;
  let phoneSuffix = 3000;
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
    const phone = `+1202555${phoneSuffix++}`;
    const actor: AccountPrincipal = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      phoneHash: vault.lookup(phone),
      displayName: 'Fixture owner',
    };
    await sql`INSERT INTO auth_user(id,name,email)
      VALUES(${actor.userId}::uuid,'Fixture owner',${`${actor.userId}@test.invalid`})`.execute(db);
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at)
      VALUES(${actor.userId}::uuid,${actor.phoneHash},${vault.seal(phone, `${actor.userId}:phone`)},'••• 3000',${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at)
      VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,${randomUUID()},
        ${new Date(now.getTime() + 86_400_000)},'passkey',${now})`.execute(db);
    await sql`INSERT INTO auth_passkey(id,user_id,public_key,credential_id,counter,device_type,backed_up)
      VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'fixture',${randomUUID()},0,'singleDevice',false)`.execute(
      db,
    );
    const settings = {
      enabled: true,
      ownerAccountId: actor.userId,
      ownerPhoneHash: actor.phoneHash,
      platformPartyId: id('pty'),
      agentId: id('agt'),
      walletId: id('wal'),
      recipientHandle: '@fixture_recipient',
      maxAmountMinor: 100,
    };
    const wallet = {
      partyId: settings.platformPartyId,
      partyType: 'PERSON' as const,
      status: 'ACTIVE' as const,
      handle: '@fixture_owner',
      primaryPhone: phone,
      walletId: settings.walletId,
      availableMinor: 400,
      currency: 'USD' as const,
    };
    let observed: OwnerPilotPayment | null = null;
    const gateway: OwnerPilotGateway = {
      getOwnerWallet: vi.fn(async () => ({ ...wallet })),
      send: vi.fn(async (input) => {
        observed = {
          id: id('pay'),
          status: 'COMPLETED',
          amountMinor: input.amountMinor,
          currency: 'USD',
          senderPartyId: settings.platformPartyId,
          senderAgentId: settings.agentId,
          recipientPartyId: id('pty'),
          recipientAgentId: null,
          tags: {
            app_operation_id: input.operationId,
            tallie_owner_pilot: 'v1',
            recipient_handle: input.recipientHandle,
          },
          feeMinor: null,
        };
        return observed;
      }),
      getPayment: vi.fn(async () => {
        if (!observed) throw new Error('No fixture payment.');
        return observed;
      }),
      findPayment: vi.fn(async () => observed),
    };
    const service = new OwnerPilotService(db, gateway, settings, () => now);
    const row = async () =>
      (
        await sql<{
          id: string;
          account_id: string;
          platform_party_id: string;
          review_id: string;
          operation_id: string;
          idempotency_key: string;
          provider_payment_id: string | null;
          status: string;
          attention: string | null;
        }>`SELECT * FROM natural_owner_pilot_sends WHERE account_id=${actor.userId}::uuid`.execute(
          db,
        )
      ).rows[0];
    return {
      actor,
      settings,
      wallet,
      gateway,
      service,
      row,
      observed: () => observed!,
      changeObserved: (patch: Partial<OwnerPilotPayment>) => {
        observed = { ...observed!, ...patch };
      },
    };
  }

  it('reviews the exact fixed tuple and journals before the only provider send', async () => {
    const f = await fixture();
    const state = await f.service.review(f.actor);
    expect(state.review).toMatchObject({ recipientHandle: '@fixture_recipient', amountMinor: 100 });
    expect(await f.row()).toBeUndefined();
    expect(f.gateway.send).not.toHaveBeenCalled();
    const original = f.gateway.send;
    vi.mocked(f.gateway.send).mockImplementationOnce(async (input) => {
      expect(await f.row()).toMatchObject({
        operation_id: input.operationId,
        status: 'submitting',
      });
      return {
        id: id('pay'),
        status: 'COMPLETED',
        amountMinor: 100,
        currency: 'USD',
        senderPartyId: f.settings.platformPartyId,
        senderAgentId: f.settings.agentId,
        recipientPartyId: id('pty'),
        recipientAgentId: null,
        tags: {
          app_operation_id: input.operationId,
          tallie_owner_pilot: 'v1',
          recipient_handle: input.recipientHandle,
        },
        feeMinor: 0,
      };
    });
    expect((await f.service.confirm(f.actor, state.review!.id)).transfer?.status).toBe('COMPLETED');
    expect(original).toHaveBeenCalledTimes(1);
    const repeated = await f.service.review(f.actor);
    expect(repeated.review).toBeNull();
    expect(repeated.transfer?.status).toBe('COMPLETED');
  });

  it('serializes concurrent reviews and confirmations without holding locks during send', async () => {
    const f = await fixture();
    const reviews = await Promise.all([f.service.review(f.actor), f.service.review(f.actor)]);
    expect(reviews[0]!.review!.id).toBe(reviews[1]!.review!.id);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = vi.mocked(f.gateway.send).getMockImplementation()!;
    vi.mocked(f.gateway.send).mockImplementation(async (input) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(input);
    });
    const first = f.service.confirm(f.actor, reviews[0]!.review!.id);
    await started;
    expect((await f.service.confirm(f.actor, reviews[0]!.review!.id)).transfer?.status).toBe(
      'submitting',
    );
    await db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM natural_owner_pilot_sends WHERE account_id=${f.actor.userId}::uuid FOR UPDATE NOWAIT`.execute(
        tx,
      );
    });
    release();
    expect((await first).transfer?.status).toBe('COMPLETED');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it.each(['recovery', 'phone_demo', 'onboarding'])('rejects %s sessions', async (kind) => {
    const f = await fixture();
    await sql`UPDATE auth_session SET assurance_kind=${kind} WHERE id=${f.actor.sessionId}::uuid`.execute(
      db,
    );
    await expect(f.service.review(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
    expect(f.gateway.getOwnerWallet).not.toHaveBeenCalled();
  });

  it('rejects old/future assurance and removed passkeys while stale sessions may read', async () => {
    const f = await fixture();
    now = new Date(initialTime.getTime() + 10 * 60_000 + 1);
    expect((await f.service.state(f.actor)).availableMinor).toBe(400);
    await expect(f.service.review(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
    now = initialTime;
    await sql`UPDATE auth_session SET assurance_at=${new Date(now.getTime() + 1)} WHERE id=${f.actor.sessionId}::uuid`.execute(
      db,
    );
    await expect(f.service.state(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
    await sql`UPDATE auth_session SET assurance_at=${now} WHERE id=${f.actor.sessionId}::uuid`.execute(
      db,
    );
    await sql`DELETE FROM auth_passkey WHERE user_id=${f.actor.userId}::uuid`.execute(db);
    await expect(f.service.review(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
  });

  it('rejects wrong account, supplied phone hash and changed current phone binding', async () => {
    const f = await fixture();
    await expect(f.service.state({ ...f.actor, userId: randomUUID() })).rejects.toMatchObject({
      code: 'OWNER_PILOT_NOT_AUTHORIZED',
    });
    await expect(
      f.service.review({ ...f.actor, phoneHash: '00'.repeat(32) }),
    ).rejects.toMatchObject({ code: 'OWNER_PILOT_NOT_AUTHORIZED' });
    await sql`UPDATE identity_phone_bindings SET phone_hash=${'01'.repeat(32)} WHERE user_id=${f.actor.userId}::uuid`.execute(
      db,
    );
    await expect(f.service.review(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
    expect(f.gateway.getOwnerWallet).not.toHaveBeenCalled();
  });

  it('blocks changed wallet, party, self destination, insufficient funds and hidden read balance', async () => {
    const f = await fixture();
    for (const patch of [
      { walletId: id('wal') },
      { partyId: id('pty') },
      { handle: f.settings.recipientHandle },
      { availableMinor: -1 },
    ]) {
      vi.mocked(f.gateway.getOwnerWallet).mockResolvedValue({ ...f.wallet, ...patch });
      await expect(f.service.review(f.actor)).rejects.toMatchObject({
        code: 'OWNER_PILOT_WALLET_CHANGED',
      });
      expect((await f.service.state(f.actor)).availableMinor).toBeNull();
    }
    vi.mocked(f.gateway.getOwnerWallet).mockResolvedValue({ ...f.wallet, availableMinor: 99 });
    await expect(f.service.review(f.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_INSUFFICIENT_BALANCE',
    });
    expect(await f.row()).toBeUndefined();
  });

  it('rechecks identity after provider reads before review or send reservation', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    vi.mocked(f.gateway.getOwnerWallet).mockImplementation(async () => {
      await sql`DELETE FROM auth_session WHERE id=${f.actor.sessionId}::uuid`.execute(db);
      return f.wallet;
    });
    await expect(f.service.confirm(f.actor, review.id)).rejects.toMatchObject({
      code: 'OWNER_PILOT_PASSKEY_REQUIRED',
    });
    expect(await f.row()).toBeUndefined();
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('expires reviews and rejects their confirmation even with fresh assurance', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    now = new Date(now.getTime() + 10 * 60_000);
    await sql`UPDATE auth_session SET assurance_at=${now} WHERE id=${f.actor.sessionId}::uuid`.execute(
      db,
    );
    await expect(f.service.confirm(f.actor, review.id)).rejects.toMatchObject({
      code: 'OWNER_PILOT_REVIEW_EXPIRED',
    });
    const next = (await f.service.review(f.actor)).review!;
    expect(next.id).not.toBe(review.id);
    await expect(f.service.confirm(f.actor, review.id)).rejects.toMatchObject({
      code: 'OWNER_PILOT_REVIEW_NOT_FOUND',
    });
    expect(f.gateway.send).not.toHaveBeenCalled();
  });

  it('never resends an unknown result and recovers the same operation after restart', async () => {
    const f = await fixture();
    const original = vi.mocked(f.gateway.send).getMockImplementation()!;
    vi.mocked(f.gateway.send).mockImplementation(async (input) => {
      await original(input);
      throw new Error('Response lost');
    });
    const review = (await f.service.review(f.actor)).review!;
    expect((await f.service.confirm(f.actor, review.id)).transfer?.status).toBe('unknown');
    const first = await f.row();
    expect((await f.service.confirm(f.actor, review.id)).transfer?.status).toBe('unknown');
    const restarted = new OwnerPilotService(db, f.gateway, f.settings, () => now);
    expect((await restarted.refresh(f.actor)).transfer?.status).toBe('COMPLETED');
    expect(await f.row()).toMatchObject({
      operation_id: first!.operation_id,
      idempotency_key: first!.idempotency_key,
    });
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
    expect(f.gateway.findPayment).toHaveBeenCalledWith(first!.operation_id);
  });

  it('keeps a missing canonical operation uncertain with no new send', async () => {
    const f = await fixture();
    vi.mocked(f.gateway.send).mockRejectedValue(new Error('Timeout'));
    const review = (await f.service.review(f.actor)).review!;
    await f.service.confirm(f.actor, review.id);
    await f.service.refresh(f.actor);
    await f.service.review(f.actor);
    await f.service.confirm(f.actor, review.id);
    expect(await f.row()).toMatchObject({ status: 'unknown', attention: 'unresolved_operation' });
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it.each(['senderPartyId', 'senderAgentId', 'amountMinor', 'tags'])(
    'rejects mismatched %s in send observations',
    async (field) => {
      const f = await fixture();
      const original = vi.mocked(f.gateway.send).getMockImplementation()!;
      vi.mocked(f.gateway.send).mockImplementation(async (input) => {
        const payment = await original(input);
        return {
          ...payment,
          ...(field === 'senderPartyId' ? { senderPartyId: id('pty') } : {}),
          ...(field === 'senderAgentId' ? { senderAgentId: id('agt') } : {}),
          ...(field === 'amountMinor' ? { amountMinor: 99 } : {}),
          ...(field === 'tags'
            ? { tags: { ...payment.tags, app_operation_id: randomUUID() } }
            : {}),
        };
      });
      const review = (await f.service.review(f.actor)).review!;
      expect((await f.service.confirm(f.actor, review.id)).transfer?.status).toBe('unknown');
      expect(await f.row()).toMatchObject({
        provider_payment_id: null,
        attention: 'binding_mismatch',
      });
      expect(f.gateway.send).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves completed/returned states and rejects changed canonical payment or recipient', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    await f.service.confirm(f.actor, review.id);
    const observed = f.observed();
    f.changeObserved({ status: 'CREATED' });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('COMPLETED');
    f.changeObserved({ recipientPartyId: id('pty'), status: 'RETURNED' });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('COMPLETED');
    expect(await f.row()).toMatchObject({ attention: 'binding_mismatch' });
    expect((await f.service.state(f.actor)).transfer?.needsStatusCheck).toBe(true);
    f.changeObserved({ recipientPartyId: observed.recipientPartyId, id: id('pay') });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('COMPLETED');
    f.changeObserved({ id: observed.id });
    expect((await f.service.refresh(f.actor)).transfer).toMatchObject({
      status: 'RETURNED',
      needsStatusCheck: false,
    });
    f.changeObserved({ status: 'COMPLETED' });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('RETURNED');
    expect(f.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('prevents replacement after failure and prevents another account from reusing the owner party', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    await f.service.confirm(f.actor, review.id);
    await sql`UPDATE natural_owner_pilot_sends SET status='FAILED' WHERE account_id=${f.actor.userId}::uuid`.execute(
      db,
    );
    expect((await f.service.review(f.actor)).transfer?.status).toBe('FAILED');
    const other = await fixture();
    const service = new OwnerPilotService(
      db,
      other.gateway,
      {
        ...other.settings,
        platformPartyId: f.settings.platformPartyId,
      },
      () => now,
    );
    vi.mocked(other.gateway.getOwnerWallet).mockResolvedValue({
      ...other.wallet,
      partyId: f.settings.platformPartyId,
    });
    await expect(service.review(other.actor)).rejects.toMatchObject({
      code: 'OWNER_PILOT_ALREADY_USED',
    });
    expect(other.gateway.send).not.toHaveBeenCalled();
  });

  it('does not enable general production submissions and reconciles when its switch is disabled', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    await f.service.confirm(f.actor, review.id);
    const disabled = new OwnerPilotService(
      db,
      f.gateway,
      { ...f.settings, enabled: false },
      () => now,
    );
    await expect(disabled.review(f.actor)).rejects.toMatchObject({ code: 'OWNER_PILOT_DISABLED' });
    f.changeObserved({ status: 'RETURNED' });
    await disabled.reconcile();
    expect((await disabled.state(f.actor)).transfer?.status).toBe('RETURNED');
    expect(
      (
        await sql<{
          submissions_paused: boolean;
        }>`SELECT submissions_paused FROM payment_runtime_controls WHERE environment='production'`.execute(
          db,
        )
      ).rows[0]?.submissions_paused,
    ).toBe(true);
  });

  it('keeps unknown fees unknown and projects no private provider or identity fields', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    const first = await f.service.confirm(f.actor, review.id);
    expect(first.transfer?.feeMinor).toBeNull();
    f.changeObserved({ feeMinor: 0 });
    const refreshed = await f.service.refresh(f.actor);
    expect(refreshed.transfer?.feeMinor).toBe(0);
    const saved = (await f.row())!;
    const serialized = JSON.stringify(refreshed);
    for (const privateValue of [
      f.actor.phoneHash,
      f.wallet.primaryPhone,
      f.settings.walletId,
      f.settings.agentId,
      f.settings.platformPartyId,
      saved.operation_id,
      saved.idempotency_key,
      saved.provider_payment_id,
    ])
      expect(serialized).not.toContain(privateValue);
    f.changeObserved({ feeMinor: null });
    expect((await f.service.refresh(f.actor)).transfer?.feeMinor).toBe(0);
  });

  it('allows initial recipient resolution but never replaces an observed recipient agent', async () => {
    const f = await fixture();
    const review = (await f.service.review(f.actor)).review!;
    await f.service.confirm(f.actor, review.id);
    const recipientAgentId = id('agt');
    f.changeObserved({ recipientAgentId });
    await f.service.refresh(f.actor);
    f.changeObserved({ recipientAgentId: id('agt'), status: 'RETURNED' });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('COMPLETED');
    expect(await f.row()).toMatchObject({ attention: 'binding_mismatch' });
    f.changeObserved({ recipientAgentId, status: 'RETURNED' });
    expect((await f.service.refresh(f.actor)).transfer?.status).toBe('RETURNED');
  });
});
