import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { PhoneVault, type ProviderVerification } from '@tallie/channels';
import { migrate } from '../../db/src/migrate';
import { createIdentityDatabase, lockAccount, type IdentityDatabase } from './database';
import { SignupService } from './signup';
import { digest, normalizePhone, opaqueToken } from './crypto';
import { createIdentityAuth, requireAccount } from './auth';
import {
  cleanupExpiredIdentityProofs,
  listAccountPasskeys,
  removeAccountPasskey,
} from './security';
config({ quiet: true });
const serviceSid = `SV${'a'.repeat(32)}`;
const origin = 'http://localhost:3000';

describe('persistent identity PostgreSQL and real WebAuthn verification', () => {
  let db: Kysely<IdentityDatabase>, admin: Pool;
  let phoneIndex = 2000;
  const schema = `tallie_identity_test_${randomUUID().replaceAll('-', '')}`;
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
    db = createIdentityDatabase(url.toString());
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  function fixture(existingPhone?: string) {
    const phone = existingPhone ?? `+1202555${phoneIndex++}`;
    const browser = opaqueToken(),
      vault = new PhoneVault('b'.repeat(64));
    let now = new Date();
    let providerResult: ProviderVerification = {
      sid: `VR${randomUUID().replaceAll('-', '')}`,
      service_sid: serviceSid,
      to: phone,
      status: 'pending',
      expires_at: new Date(now.getTime() + 300_000).toISOString(),
      delivery_target: { pool_number: '+12025550199', code: 'ABC123' },
    };
    const provider = {
      create: vi.fn(async () => ({ ...providerResult })),
      retrieve: vi.fn(async () => ({ ...providerResult })),
    };
    const service = new SignupService(db, provider, vault, serviceSid, () => now);
    return {
      phone,
      browser,
      vault,
      provider,
      service,
      result: (patch: Partial<ProviderVerification>) => {
        providerResult = { ...providerResult, ...patch };
      },
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      start: () => service.start(browser, phone, randomUUID()),
      async verified() {
        const c = await service.start(browser, phone, randomUUID());
        providerResult.status = 'approved';
        await service.check(browser, c.id);
        return c;
      },
    };
  }
  it('normalizes US phones while rejecting malformed and unsupported numbers', () => {
    expect(normalizePhone('(202) 555-0123')).toBe('+12025550123');
    expect(() => normalizePhone('+44205550123')).toThrow();
    expect(() => normalizePhone('+11025550123')).toThrow();
  });
  it('scopes a challenge to its anonymous browser and performs one provider dispatch on concurrent retries', async () => {
    const f = fixture(),
      key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.start(f.browser, f.phone, key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    await expect(f.service.check(opaqueToken(), results[0]!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(f.service.start(f.browser, '+12025559999', key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('encrypts phone/delivery data, hashes browser tokens, and never accepts a demo proof id', async () => {
    const f = fixture(),
      c = await f.start();
    const row = await db
      .selectFrom('identity_signup_transactions')
      .selectAll()
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow();
    const text = JSON.stringify(row);
    expect(text).not.toContain(f.phone);
    expect(text).not.toContain('ABC123');
    expect(text).not.toContain(f.browser);
    expect(row.browser_hash).toBe(digest(f.browser));
    await expect(
      f.service.complete(f.browser, randomUUID(), { name: 'Taylor' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it.each([
    { to: null },
    { to: '+12025559999' },
    { service_sid: `SV${'b'.repeat(32)}` },
    { sid: `VR${'b'.repeat(32)}` },
  ])('fails closed for mismatched provider approval %j', async (patch) => {
    const f = fixture(),
      c = await f.start();
    f.result({ status: 'approved', ...patch });
    expect((await f.service.check(f.browser, c.id)).status).toBe('needs_retry');
    await expect(f.service.complete(f.browser, c.id, { name: 'Taylor' })).rejects.toMatchObject({
      code: 'PHONE_PROOF_REQUIRED',
    });
  });
  it('rejects an expired proof before creating any identity', async () => {
    const f = fixture(),
      c = await f.verified();
    f.advance(300_001);
    await expect(f.service.complete(f.browser, c.id, { name: 'Taylor' })).rejects.toMatchObject({
      code: 'PHONE_PROOF_REQUIRED',
    });
  });
  it('consumes signup once and produces only an onboarding session, with a stable retry result', async () => {
    const f = fixture(),
      c = await f.verified();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.complete(f.browser, c.id, { name: 'Taylor' })),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(new Set(results.map((r) => r.sessionToken)).size).toBe(1);
    const session = await db
      .selectFrom('auth_session')
      .selectAll()
      .where('token', '=', results[0]!.sessionToken)
      .executeTakeFirstOrThrow();
    expect(session.assurance_kind).toBe('onboarding');
    expect(session.assurance_at).toBeNull();
    await expect(
      lockAccount(db, {
        userId: session.user_id,
        sessionId: session.id,
        phoneHash: f.vault.lookup(f.phone),
        displayName: 'Taylor',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await db.deleteFrom('auth_session').where('id', '=', session.id).execute();
    await expect(f.service.complete(f.browser, c.id, { name: 'Taylor' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
  it('recovers a lost signup response after the provider window without creating a new account or session', async () => {
    const f = fixture(),
      proof = await f.verified();
    expect((await f.service.current(f.browser))?.completionMode).toBeNull();
    const committed = await f.service.complete(f.browser, proof.id, { name: 'Lost reply' });
    expect((await f.service.current(f.browser))?.completionMode).toBe('signup');
    f.advance(6 * 60_000);
    expect(await f.service.complete(f.browser, proof.id, { name: 'Lost reply' })).toEqual(
      committed,
    );
    expect(
      await db
        .selectFrom('auth_session')
        .select('id')
        .where('user_id', '=', committed.userId)
        .execute(),
    ).toHaveLength(1);
    await db.deleteFrom('auth_session').where('token', '=', committed.sessionToken).execute();
    await expect(
      f.service.complete(f.browser, proof.id, { name: 'Lost reply' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('phone proof cannot take over an existing account, even if no passkey was enrolled', async () => {
    const first = fixture(),
      c = await first.verified();
    await first.service.complete(first.browser, c.id, { name: 'Taylor' });
    const other = fixture(first.phone),
      proof = await other.verified();
    await expect(
      other.service.complete(other.browser, proof.id, { name: 'Imposter' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_REQUIRED' });
  });
  it('resumes interrupted enrollment only with both the original restricted session and a new phone proof', async () => {
    const first = fixture(),
      c = await first.verified(),
      created = await first.service.complete(first.browser, c.id, { name: 'Taylor' });
    const old = await db
      .updateTable('auth_session')
      .set({ created_at: new Date(Date.now() - 20 * 60_000) })
      .where('token', '=', created.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const again = fixture(first.phone),
      proof = await again.verified();
    const resumed = await again.service.complete(
      again.browser,
      proof.id,
      { name: 'Taylor' },
      old.id,
    );
    expect(resumed.userId).toBe(created.userId);
    expect(resumed.sessionToken).not.toBe(created.sessionToken);
    expect(
      await db.selectFrom('auth_session').select('id').where('id', '=', old.id).executeTakeFirst(),
    ).toBeUndefined();
    const stranger = fixture(first.phone),
      foreign = await stranger.verified();
    await expect(
      stranger.service.complete(stranger.browser, foreign.id, { name: 'Stranger' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_REQUIRED' });
  });
  it('requires fresh strong assurance before rotating recovery codes', async () => {
    const f = fixture(),
      proof = await f.verified(),
      created = await f.service.complete(f.browser, proof.id, { name: 'Taylor' });
    const session = await db
      .selectFrom('auth_session')
      .selectAll()
      .where('token', '=', created.sessionToken)
      .executeTakeFirstOrThrow();
    const principal = {
      userId: created.userId,
      sessionId: session.id,
      phoneHash: f.vault.lookup(f.phone),
      displayName: 'Taylor',
    };
    await expect(f.service.rotateRecoveryCodes(principal)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date(Date.now() - 16 * 60_000) })
      .where('id', '=', session.id)
      .execute();
    await expect(f.service.rotateRecoveryCodes(principal)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });
  it('recovery needs a fresh bound proof and unused high-entropy code; rotates sessions and commits failure limits', async () => {
    const f = fixture(),
      c = await f.verified(),
      created = await f.service.complete(f.browser, c.id, { name: 'Taylor' });
    const session = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date() })
      .where('token', '=', created.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const principal = {
      userId: created.userId,
      sessionId: session.id,
      phoneHash: f.vault.lookup(f.phone),
      displayName: 'Taylor',
    };
    const codes = await f.service.rotateRecoveryCodes(principal);
    expect(codes).toHaveLength(8);
    expect(codes[0]).toMatch(/^([A-F0-9]{4}-){7}[A-F0-9]{4}$/);
    const rows = await db
      .selectFrom('identity_recovery_codes')
      .selectAll()
      .where('user_id', '=', created.userId)
      .execute();
    expect(JSON.stringify(rows)).not.toContain(codes[0]!);
    const recovery = fixture(f.phone),
      proof = await recovery.verified();
    await expect(
      recovery.service.complete(recovery.browser, proof.id, { recoveryCode: 'wrong' }),
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY_CODE' });
    expect(
      (
        await db
          .selectFrom('identity_signup_transactions')
          .select('recovery_attempts')
          .where('id', '=', proof.id)
          .executeTakeFirstOrThrow()
      ).recovery_attempts,
    ).toBe(1);
    const result = await recovery.service.complete(recovery.browser, proof.id, {
      recoveryCode: codes[0]!,
    });
    expect(result.userId).toBe(created.userId);
    expect((await recovery.service.current(recovery.browser))?.completionMode).toBe('recovery');
    expect(
      await db
        .selectFrom('auth_session')
        .select('id')
        .where('id', '=', session.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    const replay = fixture(f.phone),
      next = await replay.verified();
    await expect(
      replay.service.complete(replay.browser, next.id, { recoveryCode: codes[0]! }),
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY_CODE' });
  });

  it('channel proof uses only the stored phone, is bound to one account/session, and cannot become signup authority', async () => {
    const owner = fixture(),
      firstProof = await owner.verified(),
      created = await owner.service.complete(owner.browser, firstProof.id, { name: 'Owner' });
    const session = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date(), phone_verified_at: null })
      .where('token', '=', created.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const principal = {
      userId: created.userId,
      sessionId: session.id,
      phoneHash: owner.vault.lookup(owner.phone),
      displayName: 'Owner',
    };
    const channel = fixture(owner.phone);
    const challenge = await channel.service.startChannel(principal, channel.browser, randomUUID());
    expect(challenge.purpose).toBe('channel');
    expect(challenge.completionMode).toBeNull();
    expect(channel.provider.create).toHaveBeenCalledWith(serviceSid, owner.phone);
    channel.result({ status: 'approved' });
    await channel.service.check(channel.browser, challenge.id);
    await expect(
      channel.service.complete(channel.browser, challenge.id, { name: 'Not signup' }),
    ).rejects.toMatchObject({ code: 'WRONG_PROOF_PURPOSE' });
    const sibling = await db
      .insertInto('auth_session')
      .values({
        id: randomUUID(),
        user_id: created.userId,
        token: opaqueToken(),
        expires_at: new Date(Date.now() + 60_000),
        assurance_kind: 'passkey',
        assurance_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      channel.service.completeChannel(
        { ...principal, sessionId: sibling.id },
        channel.browser,
        challenge.id,
      ),
    ).rejects.toMatchObject({ code: 'WRONG_PROOF_PURPOSE' });
    const result = await channel.service.completeChannel(principal, channel.browser, challenge.id);
    expect(await channel.service.completeChannel(principal, channel.browser, challenge.id)).toEqual(
      result,
    );
    expect(
      (
        await db
          .selectFrom('auth_session')
          .select('phone_verified_at')
          .where('id', '=', session.id)
          .executeTakeFirstOrThrow()
      ).phone_verified_at?.toISOString(),
    ).toBe(result.verifiedAt);
    expect(
      (
        await db
          .selectFrom('auth_session')
          .select('phone_verified_at')
          .where('id', '=', sibling.id)
          .executeTakeFirstOrThrow()
      ).phone_verified_at,
    ).toBeNull();
    await expect(
      channel.service.completeChannel(principal, owner.browser, firstProof.id),
    ).rejects.toMatchObject({ code: 'WRONG_PROOF_PURPOSE' });
  });
  it('replays a committed channel result after provider expiry without extending phone authority', async () => {
    const owner = fixture(),
      signup = await owner.verified(),
      created = await owner.service.complete(owner.browser, signup.id, { name: 'Owner' });
    const session = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date(), phone_verified_at: null })
      .where('token', '=', created.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const principal = {
      userId: created.userId,
      sessionId: session.id,
      phoneHash: owner.vault.lookup(owner.phone),
      displayName: 'Owner',
    };
    const channel = fixture(owner.phone),
      proof = await channel.service.startChannel(principal, channel.browser, randomUUID());
    channel.result({ status: 'approved' });
    await channel.service.check(channel.browser, proof.id);
    const committed = await channel.service.completeChannel(principal, channel.browser, proof.id);
    channel.advance(6 * 60_000);
    expect((await channel.service.current(channel.browser))?.status).toBe('expired');
    expect(await channel.service.completeChannel(principal, channel.browser, proof.id)).toEqual(
      committed,
    );
    expect(
      (
        await db
          .selectFrom('auth_session')
          .select('phone_verified_at')
          .where('id', '=', session.id)
          .executeTakeFirstOrThrow()
      ).phone_verified_at?.toISOString(),
    ).toBe(committed.verifiedAt);
    channel.advance(10 * 60_000);
    await db
      .updateTable('auth_session')
      .set({ assurance_at: new Date(Date.now() + 16 * 60_000) })
      .where('id', '=', session.id)
      .execute();
    await expect(
      channel.service.completeChannel(principal, channel.browser, proof.id),
    ).rejects.toMatchObject({ code: 'FRESH_PHONE_PROOF_REQUIRED' });
  });

  it('channel proof refuses a different authenticated account and stale session assurance', async () => {
    const owner = fixture(),
      proof = await owner.verified(),
      created = await owner.service.complete(owner.browser, proof.id, { name: 'Owner' });
    const session = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date() })
      .where('token', '=', created.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const principal = {
      userId: created.userId,
      sessionId: session.id,
      phoneHash: owner.vault.lookup(owner.phone),
      displayName: 'Owner',
    };
    const channel = fixture(owner.phone),
      challenge = await channel.service.startChannel(principal, channel.browser, randomUUID());
    channel.result({ status: 'approved' });
    await channel.service.check(channel.browser, challenge.id);
    const other = fixture(),
      otherProof = await other.verified(),
      otherUser = await other.service.complete(other.browser, otherProof.id, { name: 'Other' });
    const otherSession = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date() })
      .where('token', '=', otherUser.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    await expect(
      channel.service.completeChannel(
        {
          userId: otherUser.userId,
          sessionId: otherSession.id,
          phoneHash: other.vault.lookup(other.phone),
          displayName: 'Other',
        },
        channel.browser,
        challenge.id,
      ),
    ).rejects.toMatchObject({ code: 'WRONG_PROOF_PURPOSE' });
    await db
      .updateTable('auth_session')
      .set({ assurance_at: new Date(Date.now() - 16 * 60_000) })
      .where('id', '=', session.id)
      .execute();
    await expect(
      channel.service.completeChannel(principal, channel.browser, challenge.id),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('serializes passkey removal, retains the last credential, and revokes all other sessions', async () => {
    const f = fixture(),
      proof = await f.verified(),
      user = await f.service.complete(f.browser, proof.id, { name: 'Owner' });
    const session = await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date() })
      .where('token', '=', user.sessionToken)
      .returningAll()
      .executeTakeFirstOrThrow();
    const principal = {
      userId: user.userId,
      sessionId: session.id,
      phoneHash: f.vault.lookup(f.phone),
      displayName: 'Owner',
    };
    const keys = await db
      .insertInto('auth_passkey')
      .values(
        [1, 2].map((i) => ({
          id: randomUUID(),
          user_id: user.userId,
          name: `Key ${i}`,
          public_key: 'synthetic-public-key',
          credential_id: randomUUID(),
          counter: 0,
          device_type: 'singleDevice',
          backed_up: false,
          transports: null,
          created_at: new Date(),
          aaguid: null,
        })),
      )
      .returning('id')
      .execute();
    const other = await db
      .insertInto('auth_session')
      .values({
        id: randomUUID(),
        user_id: user.userId,
        token: opaqueToken(),
        expires_at: new Date(Date.now() + 60_000),
        assurance_kind: 'passkey',
        assurance_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const summaries = await listAccountPasskeys(principal, db);
    expect(summaries).toHaveLength(2);
    expect(Object.keys(summaries[0]!)).toEqual(['id', 'name', 'createdAt']);
    const removed = await Promise.allSettled(
      keys.map((key) => removeAccountPasskey(principal, key.id, db)),
    );
    expect(removed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(removed.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'LAST_PASSKEY' },
    });
    expect(
      await db
        .selectFrom('auth_session')
        .select('id')
        .where('id', '=', other.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await listAccountPasskeys(principal, db)).toHaveLength(1);
    await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'recovery' })
      .where('id', '=', session.id)
      .execute();
    await expect(removeAccountPasskey(principal, keys[0]!.id, db)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await db
      .updateTable('auth_session')
      .set({ assurance_kind: 'passkey', assurance_at: new Date(Date.now() - 16 * 60_000) })
      .where('id', '=', session.id)
      .execute();
    await expect(removeAccountPasskey(principal, keys[0]!.id, db)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });
  it('periodically erases expired proof secrets without deleting current proofs', async () => {
    const expired = fixture(),
      old = await expired.start(),
      fresh = fixture(),
      current = await fresh.start();
    await db
      .updateTable('identity_signup_transactions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', old.id)
      .execute();
    expect(await cleanupExpiredIdentityProofs(db)).toBeGreaterThanOrEqual(1);
    const row = await db
      .selectFrom('identity_signup_transactions')
      .selectAll()
      .where('id', '=', old.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
    expect(row.phone_ciphertext).toBeNull();
    expect(row.delivery_ciphertext).toBeNull();
    expect(
      (
        await db
          .selectFrom('identity_signup_transactions')
          .select('phone_ciphertext')
          .where('id', '=', current.id)
          .executeTakeFirstOrThrow()
      ).phone_ciphertext,
    ).not.toBeNull();
  });

  function client(auth: ReturnType<typeof createIdentityAuth>, browser?: string) {
    const jar = new Map<string, string>();
    if (browser) jar.set('tallie_signup', browser);
    return {
      headers() {
        return new Headers({
          origin,
          cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        });
      },
      async request(path: string, body?: unknown, expectedAccount?: string) {
        const response = await auth.handler(
          new Request(`${origin}/api/identity/auth${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              origin,
              ...(expectedAccount ? { 'x-tallie-account': expectedAccount } : {}),
              'content-type': 'application/json',
              cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0]!;
          const split = pair.indexOf('=');
          jar.set(pair.slice(0, split), pair.slice(split + 1));
        }
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      },
    };
  }
  it('uses Better Auth real session cookies and WebAuthn signature verification for enrollment, sign-in, replay, origin and UV rejection', async () => {
    const f = fixture(),
      proof = await f.verified();
    const auth = createIdentityAuth({
      db,
      origin,
      secret: 'synthetic-test-secret-with-at-least-32-characters',
      signup: f.service,
    });
    const browser = client(auth, f.browser);
    const completed = await browser.request('/complete-phone', {
      mode: 'signup',
      challengeId: proof.id,
      name: 'Passkey Tester',
    });
    expect(completed.status).toBe(200);
    const account = (completed.body.data as { account: { id: string; ready: boolean } }).account;
    expect(account.ready).toBe(false);
    expect(
      (
        await browser.request(
          '/complete-phone',
          { mode: 'signup', challengeId: proof.id, name: 'Passkey Tester' },
          randomUUID(),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await browser.request(
          '/complete-phone',
          { mode: 'signup', challengeId: proof.id, name: 'Passkey Tester' },
          account.id,
        )
      ).status,
    ).toBe(200);
    const options = await browser.request('/passkey/generate-register-options');
    expect(options.status).toBe(200);
    const authenticator = syntheticAuthenticator();
    const enrollment = await browser.request('/passkey/verify-registration', {
      response: authenticator.registration(String(options.body.challenge)),
      name: 'Test passkey',
    });
    expect(enrollment.status).toBe(200);
    const sessions = await db
      .selectFrom('auth_session')
      .selectAll()
      .where('user_id', '=', account.id)
      .execute();
    expect(sessions[0]?.assurance_kind).toBe('passkey');
    const credential = await db
      .selectFrom('auth_passkey')
      .selectAll()
      .where('user_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(credential.credential_id).toBe(authenticator.id);
    const newcomer = client(auth);
    const authenticationOptions = await newcomer.request('/passkey/generate-authenticate-options');
    expect(authenticationOptions.status).toBe(200);
    const assertion = authenticator.authentication(String(authenticationOptions.body.challenge), 1);
    expect(
      (await newcomer.request('/passkey/verify-authentication', { response: assertion })).status,
    ).toBe(200);
    expect(
      (await newcomer.request('/passkey/verify-authentication', { response: assertion })).status,
    ).not.toBe(200);
    const established = await newcomer.request('/get-session');
    expect(established.status).toBe(200);
    const currentSession = established.body.session as { id: string };
    expect(
      (
        await db
          .selectFrom('auth_session')
          .select('assurance_kind')
          .where('id', '=', currentSession.id)
          .executeTakeFirstOrThrow()
      ).assurance_kind,
    ).toBe('passkey');
    const boundHeaders = newcomer.headers();
    boundHeaders.set('X-Tallie-Account', account.id);
    expect(
      (await requireAccount(new Request(origin, { headers: boundHeaders }), db, auth)).userId,
    ).toBe(account.id);
    boundHeaders.set('X-Tallie-Account', randomUUID());
    await expect(
      requireAccount(new Request(origin, { headers: boundHeaders }), db, auth),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', status: 409 });
    const boundOptions = await newcomer.request('/passkey/generate-authenticate-options');
    const wrongAccount = await newcomer.request(
      '/passkey/verify-authentication',
      { response: authenticator.authentication(String(boundOptions.body.challenge), 2) },
      randomUUID(),
    );
    expect(wrongAccount.status).toBe(409);
    expect(wrongAccount.body.code).toBe('ACCOUNT_CHANGED');
    expect(
      (await browser.request('/passkey/generate-register-options', undefined, randomUUID())).status,
    ).toBe(409);
    const missingUv = await newcomer.request('/passkey/generate-authenticate-options');
    expect(
      (
        await newcomer.request('/passkey/verify-authentication', {
          response: authenticator.authentication(String(missingUv.body.challenge), 2, false),
        })
      ).status,
    ).toBe(403);
    const wrongOrigin = await newcomer.request('/passkey/generate-authenticate-options');
    expect(
      (
        await newcomer.request('/passkey/verify-authentication', {
          response: authenticator.authentication(
            String(wrongOrigin.body.challenge),
            3,
            true,
            'https://evil.example',
          ),
        })
      ).status,
    ).not.toBe(200);
    const badRegistration = await browser.request('/passkey/generate-register-options');
    expect(
      (
        await browser.request('/passkey/verify-registration', {
          response: syntheticAuthenticator().registration(
            String(badRegistration.body.challenge),
            false,
          ),
        })
      ).status,
    ).toBe(403);
    expect((await newcomer.request('/passkey/delete-passkey', { id: credential.id })).status).toBe(
      403,
    );
    expect((await newcomer.request('/sign-out', {})).status).toBe(200);
    expect((await newcomer.request('/get-session')).body).toBeNull();
  });
});

// Test authenticator generates real P-256 signatures. It bypasses no verifier code.
function cbor(value: Buffer | string | number | Map<unknown, unknown>): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  return Buffer.concat([
    head(5, value.size),
    ...[...value].flatMap(([key, item]) => [
      cbor(key as Parameters<typeof cbor>[0]),
      cbor(item as Parameters<typeof cbor>[0]),
    ]),
  ]);
}
function syntheticAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credential = randomBytes(32),
    id = credential.toString('base64url');
  const key = cbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const rp = createHash('sha256').update('localhost').digest();
  function data(type: string, challenge: string, site = origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: site, crossOrigin: false }));
  }
  function responseEnvelope(client: Buffer) {
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: client.toString('base64url') },
    };
  }
  return {
    id,
    registration(challenge: string, uv = true) {
      const client = data('webauthn.create', challenge),
        length = Buffer.alloc(2);
      length.writeUInt16BE(credential.length);
      const authData = Buffer.concat([
        rp,
        Buffer.from([uv ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        credential,
        key,
      ]);
      const envelope = responseEnvelope(client);
      return {
        ...envelope,
        response: {
          ...envelope.response,
          attestationObject: cbor(
            new Map<unknown, unknown>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData],
            ]),
          ).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    authentication(challenge: string, counter: number, uv = true, site = origin) {
      const client = data('webauthn.get', challenge, site),
        count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([rp, Buffer.from([uv ? 0x05 : 0x01]), count]);
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(client).digest()]),
        privateKey as KeyObject,
      );
      const envelope = responseEnvelope(client);
      return {
        ...envelope,
        response: {
          ...envelope.response,
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
    },
  };
}
