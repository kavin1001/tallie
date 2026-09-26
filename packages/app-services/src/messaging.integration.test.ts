import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { PhoneVault } from '@tallie/channels';
import { MessagingService, type InboundMessage, type MessagingDatabase } from '@tallie/messaging';
import { SocialService, type SocialDatabase } from '@tallie/social';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../db/src/migrate';
import {
  createApplicationMessageHooks,
  currentMessageIdentity,
  lockCurrentMessageGrant,
  publishMessageDraft,
  resumeMessageDraft,
  requireFreshMessageEnrollment,
  resolveMessageRequest,
  seedRequestNotifications,
  validateMessageIdentity,
  type ApplicationDatabase,
  type MessageApplicationDependencies,
} from './messaging';

config({ quiet: true });
const line = '+12025550199';
const vault = new PhoneVault('c'.repeat(64));
let phoneSequence = 2000;

describe('real-account messaging boundary in PostgreSQL', () => {
  let db: Kysely<ApplicationDatabase>;
  let admin: Pool;
  let receiptDirectory: string;
  const schema = `tallie_app_message_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error('Local PostgreSQL required.');
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Tests require local PostgreSQL.');
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = new Kysely<ApplicationDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url.toString(), max: 8 }),
      }),
    });
    receiptDirectory = await mkdtemp(path.join(tmpdir(), 'tallie-message-receipts-'));
    vi.stubEnv('RECEIPTS_ENABLED', 'true');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (receiptDirectory) await rm(receiptDirectory, { recursive: true, force: true });
  });

  async function fixture(providerAccount = randomUUID()) {
    const now = new Date();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const phone = `+1202555${phoneSequence++}`;
    const principal = {
      userId,
      sessionId,
      phoneHash: vault.lookup(phone),
      displayName: 'Synthetic Founder',
    };
    await db
      .insertInto('auth_user')
      .values({ id: userId, name: principal.displayName, email: `${userId}@identity.invalid` })
      .execute();
    await db
      .insertInto('auth_session')
      .values({
        id: sessionId,
        user_id: userId,
        token: randomUUID(),
        expires_at: new Date(now.getTime() + 86400_000),
        assurance_kind: 'passkey',
        assurance_at: now,
        phone_verified_at: now,
      })
      .execute();
    await db
      .insertInto('identity_phone_bindings')
      .values({
        user_id: userId,
        phone_hash: principal.phoneHash,
        phone_ciphertext: vault.seal(phone, `${userId}:phone`),
        masked_phone: '•••• 0000',
        verified_at: now,
      })
      .execute();
    const deps: MessageApplicationDependencies = {
      db,
      vault,
      providerAccount,
      origin: 'https://tallie.example',
      receiptDirectory,
    };
    const hooks = createApplicationMessageHooks(deps);
    const canonical = new Map<string, InboundMessage>();
    const service = new MessagingService(
      db as unknown as Kysely<MessagingDatabase>,
      {
        retrieve: async (handle) => canonical.get(handle)!,
        send: vi.fn(async () => ({ handle: randomUUID(), status: 'sent' as const })),
      },
      hooks,
      {
        providerAccount,
        sendingLine: line,
        encryptionKey: 'd'.repeat(64),
        appOrigin: deps.origin,
        sendingEnabled: false,
      },
    );
    const identity = await currentMessageIdentity(principal, deps);
    await service.createGrant(identity, true);
    const social = new SocialService(db as unknown as Kysely<SocialDatabase>, vault, deps.origin);
    const contact = await social.addContact(
      principal,
      { label: 'Maya', phone: `+1202555${phoneSequence++}` },
      randomUUID(),
    );
    async function say(content: string) {
      const timestamp = new Date().toISOString();
      const message: InboundMessage = {
        handle: randomUUID(),
        from: phone,
        line,
        content,
        mediaUrl: null,
        occurredAt: timestamp,
        updatedAt: timestamp,
        outbound: false,
        status: 'RECEIVED',
        group: false,
        optedOut: false,
        replyTo: null,
      };
      canonical.set(message.handle, message);
      await service.ingest(message);
      await service.processInbound();
      return message;
    }
    return { principal, identity, phone, contact, social, deps, hooks, service, say };
  }

  it('binds a real strong session and verified phone, and logout immediately revokes authority', async () => {
    const f = await fixture();
    expect(await validateMessageIdentity(f.identity, f.deps)).toBe(true);
    expect(await validateMessageIdentity({ ...f.identity, phone: '+12025559999' }, f.deps)).toBe(
      false,
    );
    expect(await validateMessageIdentity({ ...f.identity, personId: randomUUID() }, f.deps)).toBe(
      false,
    );
    await db.deleteFrom('auth_session').where('id', '=', f.principal.sessionId).execute();
    expect(await validateMessageIdentity(f.identity, f.deps)).toBe(false);
    await expect(
      db.transaction().execute((tx) => lockCurrentMessageGrant(tx, f.identity, f.deps)),
    ).rejects.toThrow('CHANNEL_RECONNECT_REQUIRED');
  });

  it('enrollment requires recent phone proof and recent strong authentication', async () => {
    const f = await fixture();
    expect((await requireFreshMessageEnrollment(f.principal, f.deps)).sessionId).toBe(
      f.principal.sessionId,
    );
    await db
      .updateTable('auth_session')
      .set({ phone_verified_at: null })
      .where('id', '=', f.principal.sessionId)
      .execute();
    await expect(requireFreshMessageEnrollment(f.principal, f.deps)).rejects.toMatchObject({
      code: 'FRESH_PHONE_PROOF_REQUIRED',
    });
    await db
      .updateTable('auth_session')
      .set({ phone_verified_at: new Date(), assurance_at: new Date(0) })
      .where('id', '=', f.principal.sessionId)
      .execute();
    await expect(requireFreshMessageEnrollment(f.principal, f.deps)).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  it('connect retries reuse the active grant and keep the same conversation draft', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    const before = await f.service.state(f.principal.userId);
    await Promise.all(Array.from({ length: 5 }, () => f.service.createGrant(f.identity, true)));
    const after = await f.service.state(f.principal.userId);
    expect(after.grant?.id).toBe(before.grant?.id);
    expect(after.drafts[0]?.id).toBe(before.drafts[0]?.id);
  });

  it('the complete canonical chat flow publishes one real shared expense and no money operation', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    await f.say('equal');
    const draft = (await f.service.state(f.principal.userId)).drafts[0]!;
    await f.say(`confirm ${draft.reviewDigest!.slice(0, 12)}`);
    const completed = await f.service.getDraft(f.principal.userId, draft.id);
    expect(completed.expenseId).toBeTruthy();
    const expense = await db
      .selectFrom('social_expenses')
      .selectAll()
      .where('id', '=', completed.expenseId!)
      .executeTakeFirstOrThrow();
    expect(expense.total_minor).toBe('11700');
    const shares = await db
      .selectFrom('social_shares')
      .selectAll()
      .where('expense_id', '=', expense.id)
      .execute();
    expect(shares.map((share) => share.amount_minor).sort()).toEqual(['5850', '5850']);
    expect(
      (
        await db
          .selectFrom('operations')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe('0');
  });

  it('STOP prevents the social publication transaction even after a review was prepared', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    await f.say('equal');
    const draft = (await f.service.state(f.principal.userId)).drafts[0]!;
    await f.say('STOP');
    await expect(
      f.hooks.publishEqualSplit!({
        identity: f.identity,
        draftId: draft.id,
        version: draft.version,
        reviewDigest: draft.reviewDigest!,
        title: draft.title,
        totalMinor: draft.totalMinor!,
        participantIds: [f.identity.personId, f.contact.id],
      }),
    ).rejects.toThrow('CHANNEL_RECONNECT_REQUIRED');
    expect(
      await db
        .selectFrom('social_expenses')
        .select('id')
        .where('owner_user_id', '=', f.principal.userId)
        .execute(),
    ).toHaveLength(0);
  });

  it('STOP waits for the shared grant lock and blocks every subsequent authorized transaction', async () => {
    const f = await fixture();
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      held = resolve;
    });
    const transaction = db.transaction().execute(async (tx) => {
      await lockCurrentMessageGrant(tx, f.identity, f.deps);
      held();
      await gate;
    });
    await locked;
    const stop = f.say('STOP');
    release();
    await Promise.all([transaction, stop]);
    await expect(
      db.transaction().execute((tx) => lockCurrentMessageGrant(tx, f.identity, f.deps)),
    ).rejects.toThrow('CHANNEL_RECONNECT_REQUIRED');
  });

  it('web review uses the same permanent publication key, rejects stale/changed retries and closes the draft', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    const draft = (await f.service.state(f.principal.userId)).drafts[0]!;
    const input = {
      title: 'Dinner',
      emoji: '🍽',
      category: 'dinner' as const,
      totalMinor: '11700',
      method: 'custom' as const,
      participantIds: [f.principal.userId, f.contact.id],
      shares: [
        { participantId: f.principal.userId, amountMinor: '6000' },
        { participantId: f.contact.id, amountMinor: '5700' },
      ],
    };
    await expect(
      publishMessageDraft(f.principal, draft.id, draft.version + 1, input, f.service, f.deps),
    ).rejects.toThrow('MESSAGE_DRAFT_CHANGED');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        publishMessageDraft(f.principal, draft.id, draft.version, input, f.service, f.deps),
      ),
    );
    expect(new Set(results.map((result) => result.expenseId)).size).toBe(1);
    await expect(
      publishMessageDraft(
        f.principal,
        draft.id,
        draft.version,
        { ...input, title: 'Changed' },
        f.service,
        f.deps,
      ),
    ).rejects.toThrow('PUBLICATION_RETRY_CONFLICT');
    expect((await f.service.getDraft(f.principal.userId, draft.id)).stage).toBe('closed');
    const key = await db
      .selectFrom('social_idempotency')
      .select('key')
      .where('user_id', '=', f.principal.userId)
      .where('scope', '=', 'expense')
      .executeTakeFirstOrThrow();
    expect(key.key).toBe(`message_${draft.id}`);
  });

  it('web completion can recover its account-owned draft after channel revocation', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    const draft = (await f.service.state(f.principal.userId)).drafts[0]!;
    await f.service.revokeGrant(f.principal.userId);
    const result = await publishMessageDraft(
      f.principal,
      draft.id,
      draft.version,
      {
        title: 'Dinner',
        emoji: '🍽',
        category: 'dinner',
        totalMinor: '11700',
        method: 'equal',
        participantIds: [f.principal.userId, f.contact.id],
      },
      f.service,
      f.deps,
    );
    expect(result.expenseId).toBeTruthy();
  });

  it('reload recovers the exact encrypted custom review after its publication response is lost', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    const draft = (await f.service.state(f.principal.userId)).drafts[0]!;
    const input = {
      title: 'Edited dinner',
      emoji: '🍽',
      category: 'dinner' as const,
      totalMinor: '11700',
      method: 'custom' as const,
      participantIds: [f.principal.userId, f.contact.id],
      shares: [
        { participantId: f.principal.userId, amountMinor: '6137' },
        { participantId: f.contact.id, amountMinor: '5563' },
      ],
    };
    const original = f.service.publishDraftFromWeb.bind(f.service);
    const spy = vi
      .spyOn(f.service, 'publishDraftFromWeb')
      .mockImplementationOnce((owner, id, version, hash, saved, publish) =>
        original(owner, id, version, hash, saved, async () => {
          await publish();
          throw new Error('Lost publication response');
        }),
      );
    await expect(
      publishMessageDraft(f.principal, draft.id, draft.version, input, f.service, f.deps),
    ).rejects.toThrow('Lost publication response');
    spy.mockRestore();
    const reloaded = await f.service.getDraft(f.principal.userId, draft.id);
    expect(reloaded.publicationPending).toBe(true);
    expect(reloaded.publicationInput?.shares).toEqual(input.shares);
    const completed = await resumeMessageDraft(f.principal, draft.id, f.service, f.deps);
    expect((await f.service.getDraft(f.principal.userId, draft.id)).publicationPending).toBe(false);
    expect(
      await db
        .selectFrom('social_expenses')
        .select('id')
        .where('owner_user_id', '=', f.principal.userId)
        .execute(),
    ).toEqual([{ id: completed.expenseId }]);
    expect((await resumeMessageDraft(f.principal, draft.id, f.service, f.deps)).expenseId).toBe(
      completed.expenseId,
    );
  });

  it('request links enforce recipient or expense-owner ACL', async () => {
    const f = await fixture();
    const other = await fixture();
    const expense = await f.social.createExpense(
      f.principal,
      {
        title: 'Dinner',
        emoji: '🍽',
        category: 'dinner',
        totalMinor: '11700',
        method: 'equal',
        participantIds: [f.principal.userId, f.contact.id],
      },
      randomUUID(),
    );
    const shareId = expense.shares.find((share) => !share.isYou)!.id;
    expect((await resolveMessageRequest(f.principal, shareId, f.deps)).expenseId).toBe(expense.id);
    await expect(resolveMessageRequest(other.principal, shareId, other.deps)).rejects.toThrow(
      'MESSAGE_REQUEST_NOT_FOUND',
    );
  });

  it('notification seeding advances beyond an already handled first batch and deduplicates on reconnect', async () => {
    const providerAccount = randomUUID();
    const sender = await fixture(providerAccount);
    const recipient = await fixture(providerAccount);
    await db
      .updateTable('social_contacts')
      .set({
        connected_user_id: recipient.principal.userId,
        phone_hash: recipient.principal.phoneHash,
      })
      .where('id', '=', sender.contact.id)
      .execute();
    for (let i = 0; i < 2; i++)
      await sender.social.createExpense(
        sender.principal,
        {
          title: `Dinner ${i}`,
          emoji: '🍽',
          category: 'dinner',
          totalMinor: '11700',
          method: 'equal',
          participantIds: [sender.principal.userId, sender.contact.id],
        },
        randomUUID(),
      );
    expect(await seedRequestNotifications(1, recipient.service, recipient.deps)).toBe(1);
    expect(await seedRequestNotifications(1, recipient.service, recipient.deps)).toBe(1);
    expect(await seedRequestNotifications(1, recipient.service, recipient.deps)).toBe(0);
    await recipient.service.revokeGrant(recipient.principal.userId);
    await recipient.service.createGrant(recipient.identity, true);
    expect(await seedRequestNotifications(1, recipient.service, recipient.deps)).toBe(0);
    const count = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM message_outbox WHERE provider_account=${providerAccount} AND kind='notification'`.execute(
      db,
    );
    expect(count.rows[0]?.count).toBe('2');
  });

  it('receipt hook records an idempotent account-owned job without calling AI', async () => {
    const f = await fixture();
    const bytes = await readFile(new URL('../../receipts/fixtures/clean-117.png', import.meta.url));
    const input = {
      identity: f.identity,
      draftId: randomUUID(),
      messageId: randomUUID(),
      bytes,
      contentType: 'image/png' as const,
    };
    const first = await f.hooks.ingestReceipt!(input);
    const second = await f.hooks.ingestReceipt!(input);
    expect(first.receiptId).toBe(second.receiptId);
    const stored = await db
      .selectFrom('receipt_captures')
      .selectAll()
      .where('id', '=', first.receiptId)
      .executeTakeFirstOrThrow();
    expect(stored.account_user_id).toBe(f.principal.userId);
    expect(stored.session_id).toBeNull();
    expect(stored.status).toBe('queued');
    expect((await f.hooks.readReceipt!(f.identity, first.receiptId)).status).toBe('queued');
  });
});
