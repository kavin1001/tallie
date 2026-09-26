import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { PhoneVault, type ProviderVerification } from '@tallie/channels';
import {
  createDatabase,
  createDemoWorkspace,
  expirePhoneVerificationChallenges,
  tokenHash,
  type Database,
} from '@tallie/db';
import { migrate } from '../../../../../packages/db/src/migrate';
import { resolveSession, switchDemoPersona, type Principal } from '../session';
import { PhoneProofService } from './service';

config({ quiet: true });
const serviceSid = `SV${'a'.repeat(32)}`;

describe('development phone proof PostgreSQL invariants', () => {
  let db: Kysely<Database>;
  let admin: Pool;
  let phoneIndex = 1000;
  const schema = `tallie_phone_test_${randomUUID().replaceAll('-', '')}`;
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
    db = createDatabase(url.toString());
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function fixture() {
    const session = await createDemoWorkspace(db);
    const principal = await resolveSession(session.token, db);
    const phone = `+1202555${phoneIndex++}`;
    let now = new Date();
    let result: ProviderVerification = {
      sid: `VR${randomUUID().replaceAll('-', '')}`,
      service_sid: serviceSid,
      to: phone,
      status: 'pending',
      expires_at: new Date(now.getTime() + 300_000).toISOString(),
      delivery_target: { pool_number: '+12025550199', code: 'ABC123' },
    };
    const provider = {
      create: vi.fn(async () => {
        result = { ...result, sid: `VR${randomUUID().replaceAll('-', '')}` };
        return { ...result };
      }),
      retrieve: vi.fn(async () => ({ ...result })),
    };
    const service = new PhoneProofService(
      db,
      provider,
      new PhoneVault('a'.repeat(64)),
      serviceSid,
      () => now,
    );
    return {
      principal,
      phone,
      provider,
      service,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      result: (patch: Partial<ProviderVerification>) => {
        result = { ...result, ...patch };
      },
      create: () => service.create(principal, phone, randomUUID()),
    };
  }

  async function sibling(principal: Principal): Promise<Principal> {
    const id = randomUUID();
    await db
      .insertInto('demo_sessions')
      .values({
        id,
        workspace_id: principal.workspaceId,
        person_id: principal.personId,
        token_hash: tokenHash(randomUUID()),
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
      })
      .execute();
    return { ...principal, sessionId: id };
  }

  it('binds retries to the phone and dispatches once under concurrent creation', async () => {
    const f = await fixture();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.create(f.principal, f.phone, key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    await expect(f.service.create(f.principal, '+12025559999', key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('stores encrypted phone/code and exposes only a masked phone plus a constructed SMS link', async () => {
    const f = await fixture();
    const challenge = await f.create();
    const row = await db
      .selectFrom('phone_verification_challenges')
      .selectAll()
      .where('id', '=', challenge.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(f.phone);
    expect(JSON.stringify(row)).not.toContain('ABC123');
    expect(challenge.maskedPhone).toContain(f.phone.slice(-4));
    expect(challenge.delivery?.smsDeepLink).toEqual('sms:+12025550199?body=ABC123');
  });

  it('claims exact approved evidence once under concurrent polls and harmless replay', async () => {
    const f = await fixture();
    const challenge = await f.create();
    f.result({ status: 'approved' });
    await Promise.all(Array.from({ length: 10 }, () => f.service.check(f.principal, challenge.id)));
    expect((await f.service.check(f.principal, challenge.id)).status).toBe('verified');
    expect(f.provider.retrieve).toHaveBeenCalledTimes(1);
    const claims = await db
      .selectFrom('phone_proof_claims')
      .selectAll()
      .where('challenge_id', '=', challenge.id)
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.purpose).toBe('connect_test');
    const row = await db
      .selectFrom('phone_verification_challenges')
      .selectAll()
      .where('id', '=', challenge.id)
      .executeTakeFirstOrThrow();
    expect(row.phone_ciphertext).toBeNull();
    expect(row.delivery_ciphertext).toBeNull();
  });

  it.each([
    ['different phone', { to: '+12025559998' }],
    ['missing terminal phone', { to: null }],
    ['different service', { service_sid: `SV${'b'.repeat(32)}` }],
    ['different verification', { sid: `VR${'c'.repeat(32)}` }],
  ] as const)('rejects approved evidence with %s', async (_label, patch) => {
    const f = await fixture();
    const challenge = await f.create();
    f.result({ status: 'approved', ...patch });
    expect((await f.service.check(f.principal, challenge.id)).status).toBe('needs_retry');
    expect(
      await db
        .selectFrom('phone_proof_claims')
        .selectAll()
        .where('challenge_id', '=', challenge.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('does not accept proof from another session or workspace', async () => {
    const f = await fixture();
    const other = await fixture();
    const challenge = await f.create();
    for (const principal of [await sibling(f.principal), other.principal]) {
      await expect(f.service.check(principal, challenge.id)).rejects.toMatchObject({ status: 404 });
      await expect(f.service.cancel(principal, challenge.id)).rejects.toMatchObject({
        status: 404,
      });
    }
    expect(f.provider.retrieve).not.toHaveBeenCalled();
  });

  it('expires locally before querying the provider and erases delivery data', async () => {
    const f = await fixture();
    const challenge = await f.create();
    f.advance(300_001);
    f.result({ status: 'approved' });
    const result = await f.service.check(f.principal, challenge.id);
    expect(result.status).toBe('expired');
    expect(result.delivery).toBeNull();
    expect(f.provider.retrieve).not.toHaveBeenCalled();
  });

  it('rejects approval that returns after local expiry', async () => {
    const f = await fixture();
    const challenge = await f.create();
    f.result({ status: 'approved' });
    f.provider.retrieve.mockImplementationOnce(async () => {
      f.advance(300_001);
      return {
        sid: `VR${'b'.repeat(32)}`,
        service_sid: serviceSid,
        to: f.phone,
        status: 'approved',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
    });
    expect((await f.service.check(f.principal, challenge.id)).status).toBe('expired');
  });

  it('keeps cancellation final when provider approval arrives later', async () => {
    const f = await fixture();
    const challenge = await f.create();
    f.result({ status: 'approved' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.provider.retrieve.getMockImplementation()!;
    f.provider.retrieve.mockImplementationOnce(async () => {
      await gate;
      return original();
    });
    const pending = f.service.check(f.principal, challenge.id);
    await vi.waitFor(() => expect(f.provider.retrieve).toHaveBeenCalledTimes(1));
    expect((await f.service.cancel(f.principal, challenge.id)).status).toBe('canceled');
    release();
    expect((await pending).status).toBe('canceled');
  });

  it('revokes in-flight approval when the demo session is rotated', async () => {
    const f = await fixture();
    const challenge = await f.create();
    f.result({ status: 'approved' });
    const original = f.provider.retrieve.getMockImplementation()!;
    f.provider.retrieve.mockImplementationOnce(async () => {
      await switchDemoPersona(f.principal, f.principal.personId, db);
      return original();
    });
    await expect(f.service.check(f.principal, challenge.id)).rejects.toMatchObject({ status: 401 });
    expect(
      await db
        .selectFrom('phone_proof_claims')
        .selectAll()
        .where('challenge_id', '=', challenge.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('retains one failed intent after an ambiguous provider create without retrying it', async () => {
    const f = await fixture();
    const key = randomUUID();
    f.provider.create.mockRejectedValueOnce(new Error('network timeout'));
    expect((await f.service.create(f.principal, f.phone, key)).status).toBe('failed');
    expect((await f.service.create(f.principal, f.phone, key)).status).toBe('failed');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
  });

  it('limits repeated requests across browser sessions and does not charge idempotent retries twice', async () => {
    const f = await fixture();
    const key = randomUUID();
    await f.service.create(f.principal, f.phone, key);
    await f.service.create(f.principal, f.phone, key);
    for (let i = 0; i < 4; i++)
      await f.service.create(await sibling(f.principal), f.phone, randomUUID());
    await expect(
      f.service.create(await sibling(f.principal), f.phone, randomUUID()),
    ).rejects.toMatchObject({ status: 429 });
    expect(f.provider.create).toHaveBeenCalledTimes(5);
  });

  it('throttles provider polling to at most once every three seconds', async () => {
    const f = await fixture();
    const challenge = await f.create();
    await f.service.check(f.principal, challenge.id);
    await f.service.check(f.principal, challenge.id);
    expect(f.provider.retrieve).toHaveBeenCalledTimes(1);
    f.advance(3_001);
    await f.service.check(f.principal, challenge.id);
    expect(f.provider.retrieve).toHaveBeenCalledTimes(2);
  });

  it('background maintenance erases abandoned secrets and preserves completed proofs', async () => {
    const pending = await fixture();
    const abandoned = await pending.create();
    const complete = await fixture();
    const verified = await complete.create();
    complete.result({ status: 'approved' });
    await complete.service.check(complete.principal, verified.id);
    const future = new Date(Date.now() + 301_000);
    expect(await expirePhoneVerificationChallenges(db, future)).toBeGreaterThanOrEqual(1);
    const expired = await db
      .selectFrom('phone_verification_challenges')
      .selectAll()
      .where('id', '=', abandoned.id)
      .executeTakeFirstOrThrow();
    expect(expired.status).toBe('expired');
    expect(expired.phone_ciphertext).toBeNull();
    expect(expired.delivery_ciphertext).toBeNull();
    expect((await complete.service.state(complete.principal)).challenge?.status).toBe('verified');
    expect(await expirePhoneVerificationChallenges(db, future)).toBe(0);
  });

  it('supersedes an earlier challenge without changing the financial persona', async () => {
    const f = await fixture();
    const first = await f.create();
    const second = await f.create();
    expect((await f.service.check(f.principal, first.id)).status).toBe('canceled');
    expect(second.status).toBe('pending');
    expect((await f.service.state(f.principal)).challenge?.id).toBe(second.id);
    expect(
      await db
        .selectFrom('people')
        .select('id')
        .where('id', '=', f.principal.personId)
        .executeTakeFirst(),
    ).toBeDefined();
  });
});
