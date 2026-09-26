import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PhoneVault } from '@tallie/channels';
import { createDatabase } from '@tallie/db';
import { migrate } from '../../db/src/migrate';
import { SocialService, type SocialPrincipal } from './service';
import type { SocialDatabase } from './schema';
import type { SocialInvitation } from './contracts';

config({ quiet: true });
describe('real account social PostgreSQL invariants', () => {
  const schema = `tallie_social_test_${randomUUID().replaceAll('-', '')}`;
  const vault = new PhoneVault('b'.repeat(64));
  let db: Kysely<SocialDatabase>;
  let admin: Pool;
  let phoneIndex = 1000;
  let now = new Date();
  let service: SocialService;
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
    db = createDatabase(url.toString()) as unknown as Kysely<SocialDatabase>;
    service = new SocialService(db, vault, 'http://localhost:3000', () => now);
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  afterEach(() => vi.unstubAllEnvs());
  function enablePhoneDemo() {
    vi.stubEnv('APP_MODE', 'beta');
    vi.stubEnv('APP_PREVIEW_MODE', 'true');
    vi.stubEnv('IDENTITY_PHONE_DEMO_ENABLED', 'true');
  }
  async function account(name = 'Friend', assurance = 'passkey', phoneDemo = false) {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const phone = `+1202555${phoneIndex++}`;
    const actor: SocialPrincipal = {
      userId,
      sessionId,
      displayName: name,
      phoneHash: vault.lookup(phone),
    };
    await sql`INSERT INTO auth_user(id,name,email,phone_demo) VALUES(${userId}::uuid,${name},${`${userId}@test.invalid`},${phoneDemo})`.execute(
      db,
    );
    await sql`INSERT INTO identity_phone_bindings(user_id,phone_hash,phone_ciphertext,masked_phone,verified_at) VALUES(${userId}::uuid,${actor.phoneHash},${vault.seal(phone, `${userId}:phone`)},${`••• ${phone.slice(-4)}`},${now})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${sessionId}::uuid,${userId}::uuid,${randomUUID()},${new Date(now.getTime() + 30 * 86_400_000)},${assurance},${now})`.execute(
      db,
    );
    return { actor, phone };
  }
  async function fixture() {
    const owner = await account('Alex');
    const friend = await account('Maya');
    const outsider = await account('Leo');
    const contact = await service.addContact(
      owner.actor,
      { label: 'Private nickname', phone: friend.phone },
      randomUUID(),
    );
    return { owner, friend, outsider, contact };
  }
  const token = (invite: SocialInvitation) =>
    new URLSearchParams(new URL(invite.url).hash.slice(1)).get('token')!;
  async function split(f: Awaited<ReturnType<typeof fixture>>, totalMinor = '11700') {
    return service.createExpense(
      f.owner.actor,
      {
        title: 'Dinner',
        emoji: '🍝',
        category: 'dinner',
        totalMinor,
        participantIds: [f.owner.actor.userId, f.contact.id],
        method: 'equal',
      },
      randomUUID(),
    );
  }

  it('keeps account discovery opaque, rejects self, and encrypts a contact phone', async () => {
    const f = await fixture();
    expect(f.contact.status).toBe('invitation_needed');
    expect(JSON.stringify(f.contact)).not.toContain(f.friend.phone);
    const stored = await db
      .selectFrom('social_contacts')
      .selectAll()
      .where('id', '=', f.contact.id)
      .executeTakeFirstOrThrow();
    expect(stored.phone_ciphertext).not.toContain(f.friend.phone);
    expect(vault.open(stored.phone_ciphertext!, `social-contact:${stored.id}`)).toBe(
      f.friend.phone,
    );
    await expect(
      service.addContact(f.owner.actor, { label: 'Me', phone: f.owner.phone }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SELF_CONTACT' });
  });
  it('serializes duplicate contacts and binds idempotency to the request', async () => {
    const a = await account();
    const b = await account();
    const key = randomUUID();
    const body = { label: 'Maya', phone: b.phone };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => service.addContact(a.actor, body, key)),
    );
    expect(new Set(responses.map((row) => row.id)).size).toBe(1);
    const repeat = await service.addContact(a.actor, body, randomUUID());
    expect(repeat.id).toBe(responses[0]!.id);
    await expect(
      service.addContact(a.actor, { ...body, label: 'Changed' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects revoked and phone-only enrollment sessions for real social commands', async () => {
    const a = await account('New', 'onboarding');
    const b = await account();
    await expect(
      service.addContact(a.actor, { label: 'Friend', phone: b.phone }, randomUUID()),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await sql`DELETE FROM auth_session WHERE id=${b.actor.sessionId}::uuid`.execute(db);
    await expect(
      service.addContact(b.actor, { label: 'Friend', phone: a.phone }, randomUUID()),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('lets marked phone-demo accounts split and claim only the intended invitation without financial operations', async () => {
    enablePhoneDemo();
    const owner = await account('Alex', 'phone_demo', true);
    const friend = await account('Maya', 'phone_demo', true);
    const outsider = await account('Leo', 'phone_demo', true);
    const contact = await service.addContact(
      owner.actor,
      { label: 'Private nickname', phone: friend.phone },
      randomUUID(),
    );
    const expense = await split({ owner, friend, outsider, contact }, '11701');
    const invitation = await service.createInvitation(
      owner.actor,
      { contactId: contact.id, expenseId: expense.id },
      randomUUID(),
    );
    await expect(service.claimInvitation(outsider.actor, token(invitation))).rejects.toMatchObject({
      code: 'INVITATION_UNAVAILABLE',
    });
    await service.claimInvitation(friend.actor, token(invitation));
    const claimed = await service.expense(friend.actor.userId, expense.id);
    expect(claimed.shares.reduce((sum, share) => sum + BigInt(share.amountMinor), 0n)).toBe(11701n);
    expect(claimed.shares.find((share) => share.isYou)?.name).toBe('Maya');
    expect(JSON.stringify(claimed)).not.toContain('Private nickname');
    expect(claimed.paymentsEnabled).toBe(false);
    const share = expense.shares.find((row) => !row.isYou)!;
    await service.cancelShare(owner.actor, expense.id, share.id);
    expect((await service.dashboard(owner.actor)).summary.owedToYouMinor).toBe('0');
    expect(
      (await sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM operations`.execute(db))
        .rows[0]?.count,
    ).toBe('0');
  });
  it('denies phone-demo mutations and cached command retries immediately after the feature is disabled', async () => {
    enablePhoneDemo();
    const owner = await account('Alex', 'phone_demo', true);
    const friend = await account('Maya', 'phone_demo', true);
    const contactKey = randomUUID();
    const contactInput = { label: 'Maya', phone: friend.phone };
    const contact = await service.addContact(owner.actor, contactInput, contactKey);
    const expense = await service.createExpense(
      owner.actor,
      {
        title: 'Dinner',
        emoji: '🍝',
        category: 'dinner',
        totalMinor: '2000',
        participantIds: [owner.actor.userId, contact.id],
        method: 'equal',
      },
      randomUUID(),
    );
    const invitation = await service.createInvitation(
      owner.actor,
      { contactId: contact.id, expenseId: expense.id },
      randomUUID(),
    );
    vi.stubEnv('IDENTITY_PHONE_DEMO_ENABLED', 'false');
    await expect(service.addContact(owner.actor, contactInput, contactKey)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(service.claimInvitation(friend.actor, token(invitation))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(service.revokeInvitation(owner.actor, invitation.id)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(
      service.cancelShare(
        owner.actor,
        expense.id,
        expense.shares.find((share) => !share.isYou)!.id,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect((await service.inspectInvitation(token(invitation))).status).toBe('available');
    expect(
      (await service.expense(owner.actor.userId, expense.id)).shares.some(
        (share) => share.status === 'canceled',
      ),
    ).toBe(false);
  });
  it('does not grant phone-demo access to an unmarked established account', async () => {
    enablePhoneDemo();
    const user = await account('Existing', 'phone_demo');
    const friend = await account();
    await expect(
      service.addContact(user.actor, { label: 'Friend', phone: friend.phone }, randomUUID()),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('rejects an old phone-demo session if passkey enrollment committed before its promotion hook', async () => {
    enablePhoneDemo();
    const user = await account('Newly secured', 'phone_demo', true);
    const friend = await account();
    await sql`INSERT INTO auth_passkey(id,user_id,public_key,credential_id,counter,device_type,backed_up)
      VALUES(${randomUUID()}::uuid,${user.actor.userId}::uuid,'synthetic-public-key',${randomUUID()},0,'singleDevice',false)`.execute(
      db,
    );
    await expect(
      service.addContact(user.actor, { label: 'Friend', phone: friend.phone }, randomUUID()),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it.each(['revoked', 'expired', 'wrong account', 'wrong phone'] as const)(
    'preserves session and identity binding for a %s phone-demo session',
    async (failure) => {
      enablePhoneDemo();
      const owner = await account('Alex', 'phone_demo', true);
      const friend = await account('Maya', 'phone_demo', true);
      let actor = owner.actor;
      if (failure === 'revoked')
        await sql`DELETE FROM auth_session WHERE id=${actor.sessionId}::uuid`.execute(db);
      else if (failure === 'expired')
        await sql`UPDATE auth_session SET expires_at=${new Date(now.getTime() - 1)} WHERE id=${actor.sessionId}::uuid`.execute(
          db,
        );
      else if (failure === 'wrong account') actor = { ...actor, sessionId: friend.actor.sessionId };
      else actor = { ...actor, phoneHash: friend.actor.phoneHash };
      await expect(
        service.addContact(actor, { label: 'Friend', phone: '+12025550000' }, randomUUID()),
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    },
  );
  it('never resolves an ambiguous alias or guesses a partial name', async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    await service.addContact(a.actor, { label: 'Maya', phone: b.phone }, randomUUID());
    await service.addContact(a.actor, { label: 'maya', phone: c.phone }, randomUUID());
    expect(await service.resolveContacts(a.actor.userId, ['Maya', 'May'])).toEqual({
      participants: [],
      unresolvedNames: ['Maya', 'May'],
    });
  });
  it('creates exact separate obligations with no financial operations', async () => {
    const f = await fixture();
    const expense = await split(f, '11701');
    expect(expense.shares.reduce((sum, s) => sum + BigInt(s.amountMinor), 0n)).toBe(11701n);
    expect(expense.shares.filter((s) => s.status === 'invite_ready')).toHaveLength(1);
    expect(expense.paymentsEnabled).toBe(false);
    const operations = await sql<{
      count: string;
    }>`SELECT COUNT(*)::text AS count FROM operations`.execute(db);
    expect(operations.rows[0]!.count).toBe('0');
    await expect(service.expense(f.friend.actor.userId, expense.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('preserves item allocation exactly and rejects missing tax or mismatched totals', async () => {
    const f = await fixture();
    const ids = [f.owner.actor.userId, f.contact.id];
    const input = {
      title: 'Dinner',
      emoji: '🍝',
      category: 'dinner' as const,
      totalMinor: '11700',
      participantIds: ids,
      method: 'items' as const,
      items: [
        { id: 'food', name: 'Food', amountMinor: '6000', participantIds: ids },
        { id: 'wine', name: 'Wine', amountMinor: '3000', participantIds: [f.owner.actor.userId] },
      ],
      taxMinor: '900',
      tipMinor: '1800',
    };
    const expense = await service.createExpense(f.owner.actor, input, randomUUID());
    expect(expense.shares.find((s) => s.participantId === f.contact.id)?.amountMinor).toBe('3900');
    await expect(
      service.createExpense(f.owner.actor, { ...input, totalMinor: '11800' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'TOTAL_MISMATCH' });
    const { taxMinor: _, ...missing } = input;
    await expect(service.createExpense(f.owner.actor, missing, randomUUID())).rejects.toMatchObject(
      { code: 'INCOMPLETE_RECEIPT' },
    );
  });
  it('rejects another owner’s contact and mismatched custom participant sets', async () => {
    const f = await fixture();
    const base = {
      title: 'Dinner',
      emoji: '🍝',
      category: 'dinner' as const,
      totalMinor: '1000',
      participantIds: [f.outsider.actor.userId, f.contact.id],
      method: 'equal' as const,
    };
    await expect(service.createExpense(f.outsider.actor, base, randomUUID())).rejects.toMatchObject(
      { code: 'INVALID_PARTICIPANTS' },
    );
    await expect(
      service.createExpense(
        f.owner.actor,
        {
          ...base,
          participantIds: [f.owner.actor.userId, f.contact.id],
          method: 'custom',
          shares: [
            { participantId: f.owner.actor.userId, amountMinor: '1000' },
            { participantId: f.owner.actor.userId, amountMinor: '0' },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARTICIPANTS' });
    const canonical = await service.createExpense(
      f.owner.actor,
      { ...base, participantIds: [f.owner.actor.userId.toUpperCase(), f.contact.id.toUpperCase()] },
      randomUUID(),
    );
    expect(canonical.shares.map((share) => share.participantId)).toContain(f.contact.id);
  });
  it('publishes one expense under concurrent retries and rejects changed contents', async () => {
    const f = await fixture();
    const key = randomUUID();
    const input = {
      title: 'Tickets',
      emoji: '🎟️',
      category: 'tickets' as const,
      totalMinor: '2000',
      participantIds: [f.owner.actor.userId, f.contact.id],
      method: 'equal' as const,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.createExpense(f.owner.actor, input, key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await expect(
      service.createExpense(f.owner.actor, { ...input, totalMinor: '2500' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('returns a minimal public invitation and keeps its token out of URL paths and plaintext storage', async () => {
    const f = await fixture();
    const expense = await split(f);
    const key = randomUUID();
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      key,
    );
    expect(new URL(invite.url).pathname).toBe('/invite');
    expect(new URL(invite.url).search).toBe('');
    const inspected = await service.inspectInvitation(token(invite));
    expect(inspected).toEqual({ status: 'available', purpose: 'join_tallie' });
    const stored = await db
      .selectFrom('social_invitations')
      .selectAll()
      .where('id', '=', invite.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain(token(invite));
    expect(
      (
        await service.createInvitation(
          f.owner.actor,
          { contactId: f.contact.id, expenseId: expense.id },
          key,
        )
      ).url,
    ).toBe(invite.url);
  });
  it('rejects forwarded links and claims only the intended expense, without leaking private aliases', async () => {
    const f = await fixture();
    const first = await split(f);
    const unrelated = await split(f);
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: first.id },
      randomUUID(),
    );
    await expect(service.claimInvitation(f.outsider.actor, token(invite))).rejects.toMatchObject({
      code: 'INVITATION_UNAVAILABLE',
    });
    await service.claimInvitation(f.friend.actor, token(invite));
    const expense = await service.expense(f.friend.actor.userId, first.id);
    expect(expense.shares.find((s) => s.isYou)?.name).toBe('Maya');
    expect(JSON.stringify(expense)).not.toContain('Private nickname');
    await expect(service.expense(f.friend.actor.userId, unrelated.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const friendDashboard = await service.dashboard(f.friend.actor);
    expect(friendDashboard.contacts[0]?.label).toBe('Alex');
    expect(friendDashboard.contacts[0]?.status).toBe('connected');
  });
  it('consumes invitation identity evidence once and tolerates concurrent same-account claims', async () => {
    const f = await fixture();
    const expense = await split(f);
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      randomUUID(),
    );
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => service.claimInvitation(f.friend.actor, token(invite))),
    );
    expect(claims.every((c) => c.expenseId === expense.id)).toBe(true);
    const count = await db
      .selectFrom('social_invitation_claims')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('invitation_id', '=', invite.id)
      .executeTakeFirstOrThrow();
    expect(count.count).toBe('1');
    expect(await service.inspectInvitation(token(invite))).toEqual({
      status: 'unavailable',
      purpose: 'join_tallie',
    });
  });
  it('connects future expenses after a friendship invite while older drafts stay invitation-only', async () => {
    const f = await fixture();
    const old = await split(f);
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id },
      randomUUID(),
    );
    await service.claimInvitation(f.friend.actor, token(invite));
    await expect(service.expense(f.friend.actor.userId, old.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const fresh = await split(f);
    expect(
      (await service.expense(f.friend.actor.userId, fresh.id)).shares.find((s) => s.isYou)?.status,
    ).toBe('payment_setup_pending');
  });
  it('expires and revokes invitations without deleting the original obligation', async () => {
    const f = await fixture();
    const expense = await split(f);
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      randomUUID(),
    );
    await service.revokeInvitation(f.owner.actor, invite.id);
    await expect(service.claimInvitation(f.friend.actor, token(invite))).rejects.toMatchObject({
      code: 'INVITATION_UNAVAILABLE',
    });
    const expired = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      randomUUID(),
    );
    await db
      .updateTable('social_invitations')
      .set({ expires_at: new Date(now.getTime() - 1) })
      .where('id', '=', expired.id)
      .execute();
    await expect(service.claimInvitation(f.friend.actor, token(expired))).rejects.toMatchObject({
      code: 'INVITATION_EXPIRED',
    });
    expect(
      (await service.expense(f.owner.actor.userId, expense.id)).shares.some(
        (s) => s.status === 'invite_ready',
      ),
    ).toBe(true);
  });
  it('keeps original phone identity immutable when account lookup would change', async () => {
    const f = await fixture();
    const expense = await split(f);
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      randomUUID(),
    );
    const stale = { ...f.friend.actor, phoneHash: f.owner.actor.phoneHash };
    await expect(service.claimInvitation(stale, token(invite))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
  it('cancels only owner shares, prevents stale invite acceptance, and excludes canceled balances', async () => {
    const f = await fixture();
    const expense = await split(f);
    const share = expense.shares.find((s) => !s.isYou)!;
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id, expenseId: expense.id },
      randomUUID(),
    );
    await expect(service.cancelShare(f.outsider.actor, expense.id, share.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    const canceled = await service.cancelShare(f.owner.actor, expense.id, share.id);
    expect(canceled.shares.find((s) => s.id === share.id)?.status).toBe('canceled');
    await expect(service.claimInvitation(f.friend.actor, token(invite))).rejects.toMatchObject({
      code: 'INVITATION_UNAVAILABLE',
    });
    expect((await service.dashboard(f.owner.actor)).summary.owedToYouMinor).toBe('0');
  });
  it('requires a transaction-bound channel grant before agent publication', async () => {
    const f = await fixture();
    const input = {
      title: 'Chat dinner',
      emoji: '🍽️',
      category: 'dinner' as const,
      totalMinor: '6000',
      participantIds: [f.owner.actor.userId, f.contact.id],
      method: 'equal' as const,
    };
    const { sessionId: _, ...actor } = f.owner.actor;
    await expect(
      service.createExpenseFromChannel(actor, input, randomUUID(), async () => {
        throw new Error('Grant expired');
      }),
    ).rejects.toThrow('Grant expired');
    let authorized = false;
    const expense = await service.createExpenseFromChannel(
      actor,
      input,
      randomUUID(),
      async (tx) => {
        await sql`SELECT 1`.execute(tx);
        authorized = true;
      },
    );
    expect(authorized).toBe(true);
    expect(expense.title).toBe('Chat dinner');
  });
  it('connects simultaneous opposite-direction invitations without a lock-order deadlock', async () => {
    const f = await fixture();
    const reverse = await service.addContact(
      f.friend.actor,
      { label: 'Alex from dinner', phone: f.owner.phone },
      randomUUID(),
    );
    const forwardInvite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id },
      randomUUID(),
    );
    const reverseInvite = await service.createInvitation(
      f.friend.actor,
      { contactId: reverse.id },
      randomUUID(),
    );
    await Promise.all([
      service.claimInvitation(f.friend.actor, token(forwardInvite)),
      service.claimInvitation(f.owner.actor, token(reverseInvite)),
    ]);
    const owner = await service.dashboard(f.owner.actor);
    const friend = await service.dashboard(f.friend.actor);
    expect(owner.contacts).toHaveLength(1);
    expect(friend.contacts).toHaveLength(1);
    expect(owner.contacts[0]?.status).toBe('connected');
    expect(friend.contacts[0]?.status).toBe('connected');
    expect(friend.contacts[0]?.label).toBe('Alex from dinner');
  });
  it('serializes revocation against acceptance with one truthful terminal outcome', async () => {
    const f = await fixture();
    const invite = await service.createInvitation(
      f.owner.actor,
      { contactId: f.contact.id },
      randomUUID(),
    );
    const result = await Promise.allSettled([
      service.claimInvitation(f.friend.actor, token(invite)),
      service.revokeInvitation(f.owner.actor, invite.id),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const stored = await db
      .selectFrom('social_invitations')
      .selectAll()
      .where('id', '=', invite.id)
      .executeTakeFirstOrThrow();
    expect(Boolean(stored.claimed_at)).not.toBe(Boolean(stored.revoked_at));
    const proof = await db
      .selectFrom('social_invitation_claims')
      .select('invitation_id')
      .where('invitation_id', '=', invite.id)
      .execute();
    expect(proof.length).toBe(stored.claimed_at ? 1 : 0);
  });
  it('aggregates obligations beyond the bounded dashboard history window', async () => {
    const f = await fixture();
    const expense = await split(f, '2000');
    const base = await db
      .selectFrom('social_expenses')
      .selectAll()
      .where('id', '=', expense.id)
      .executeTakeFirstOrThrow();
    const shares = await db
      .selectFrom('social_shares')
      .selectAll()
      .where('expense_id', '=', expense.id)
      .execute();
    await db.transaction().execute(async (tx) => {
      for (let i = 0; i < 105; i++) {
        const id = randomUUID();
        await tx
          .insertInto('social_expenses')
          .values({ ...base, id, items: JSON.stringify(base.items) })
          .execute();
        await tx
          .insertInto('social_shares')
          .values(shares.map((share) => ({ ...share, id: randomUUID(), expense_id: id })))
          .execute();
      }
    });
    const dashboard = await service.dashboard(f.owner.actor);
    expect(dashboard.expenses).toHaveLength(100);
    expect(dashboard.summary.owedToYouMinor).toBe('106000');
    expect((await service.expense(f.owner.actor.userId, expense.id)).id).toBe(expense.id);
  });
});
