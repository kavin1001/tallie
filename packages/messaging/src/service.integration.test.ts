import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../db/src/migrate';
import { MessagingService } from './service';
import {
  DeliveryError,
  type InboundMessage,
  type MessageIdentity,
  type MessagingHooks,
  type MessagingTransport,
} from './contracts';
import type { MessagingDatabase } from './schema';

config({ quiet: true });
const line = '+12025550199';
let phoneSequence = 1000;

describe('messaging actual PostgreSQL invariants', () => {
  let db: Kysely<MessagingDatabase>;
  let admin: Pool;
  const schema = `tallie_messaging_test_${randomUUID().replaceAll('-', '')}`;
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
    db = new Kysely<MessagingDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url.toString(), max: 6 }),
      }),
    });
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function fixture(
    options: {
      sending?: boolean;
      consent?: boolean;
      connected?: boolean;
      providerAccount?: string;
    } = {},
  ) {
    let now = new Date();
    let valid = true;
    let notificationEligible = true;
    let receiptResult: Awaited<ReturnType<NonNullable<MessagingHooks['readReceipt']>>> = {
      status: 'processing',
    };
    const identity: MessageIdentity = {
      accountId: randomUUID(),
      personId: randomUUID(),
      sessionId: randomUUID(),
      phone: `+1202555${phoneSequence++}`,
      bindingEpoch: 0,
    };
    const providerAccount = options.providerAccount ?? randomUUID();
    const canonical = new Map<string, InboundMessage>();
    const published = new Map<string, string>();
    const contacts = [
      { personId: randomUUID(), name: 'Maya' },
      { personId: randomUUID(), name: 'Leo' },
    ];
    const transport: MessagingTransport = {
      retrieve: vi.fn(async (handle) => {
        const message = canonical.get(handle);
        if (!message) throw new Error('Unavailable fixture');
        return { ...message };
      }),
      send: vi.fn<MessagingTransport['send']>(async () => ({
        handle: randomUUID(),
        status: 'sent',
      })),
    };
    const hooks: MessagingHooks = {
      validateIdentity: vi.fn(
        async (candidate) =>
          valid &&
          candidate.accountId === identity.accountId &&
          candidate.phone === identity.phone &&
          candidate.sessionId === identity.sessionId,
      ),
      resolveContacts: vi.fn<MessagingHooks['resolveContacts']>(async (_identity, names) => ({
        participants: names.flatMap((name) => contacts.filter((contact) => contact.name === name)),
        unresolvedNames: names.filter((name) => !contacts.some((contact) => contact.name === name)),
      })),
      publishEqualSplit: vi.fn(async (input) => {
        if (!published.has(input.draftId)) published.set(input.draftId, randomUUID());
        return { expenseId: published.get(input.draftId)! };
      }),
      ingestReceipt: vi.fn(async () => ({ receiptId: randomUUID() })),
      readReceipt: vi.fn(async () => receiptResult),
      notificationEligible: vi.fn(async () => notificationEligible),
    };
    const service = new MessagingService(db, transport, hooks, {
      providerAccount,
      sendingLine: line,
      encryptionKey: 'a'.repeat(64),
      appOrigin: 'https://tallie.example',
      sendingEnabled: options.sending ?? true,
      now: () => now,
      downloadMedia: vi.fn(async () => ({
        bytes: Buffer.from('synthetic, never decoded'),
        contentType: 'image/png' as const,
      })),
    });
    if (options.connected !== false) await service.createGrant(identity, options.consent ?? true);
    function message(content: string, patch: Partial<InboundMessage> = {}): InboundMessage {
      const value: InboundMessage = {
        handle: randomUUID(),
        from: identity.phone,
        line,
        content,
        mediaUrl: null,
        occurredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        outbound: false,
        status: 'RECEIVED',
        group: false,
        optedOut: false,
        replyTo: null,
        ...patch,
      };
      canonical.set(value.handle, { ...value });
      return value;
    }
    async function say(content: string, patch: Partial<InboundMessage> = {}) {
      now = new Date(now.getTime() + 1);
      const value = message(content, patch);
      await service.ingest(value);
      await service.processInbound();
      return value;
    }
    return {
      service,
      transport,
      hooks,
      identity,
      providerAccount,
      canonical,
      published,
      message,
      say,
      invalidate: () => {
        valid = false;
      },
      setNotification: (value: boolean) => {
        notificationEligible = value;
      },
      receiptResult: (value: typeof receiptResult) => {
        receiptResult = value;
      },
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      drafts: async () => (await service.state(identity.accountId)).drafts,
      outbox: () =>
        db
          .selectFrom('message_outbox')
          .selectAll()
          .where('provider_account', '=', providerAccount)
          .orderBy('created_at', 'asc')
          .execute(),
    };
  }

  it('atomically deduplicates concurrent webhook deliveries and rejects changed payloads', async () => {
    const f = await fixture();
    const message = f.message('hi');
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service.ingest(message)));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    await expect(f.service.ingest({ ...message, content: 'different' })).rejects.toThrow(
      'MESSAGE_REPLAY_CONFLICT',
    );
    await f.service.processInbound();
    expect(await f.outbox()).toHaveLength(1);
    expect(vi.mocked(f.transport.retrieve)).toHaveBeenCalledTimes(1);
  });

  it('encrypts message and draft content and isolates account draft reads', async () => {
    const f = await fixture();
    await f.say('split $117 for Secret dinner with Maya and Leo');
    const draft = (await f.drafts())[0]!;
    await expect(f.service.getDraft(randomUUID(), draft.id)).rejects.toThrow(
      'MESSAGE_DRAFT_NOT_FOUND',
    );
    const row = await db
      .selectFrom('message_drafts')
      .selectAll()
      .where('id', '=', draft.id)
      .executeTakeFirstOrThrow();
    expect(row.payload_ciphertext).not.toContain('Secret dinner');
    const inbox = await db
      .selectFrom('message_inbox')
      .selectAll()
      .where('provider_account', '=', f.providerAccount)
      .executeTakeFirstOrThrow();
    expect(inbox.payload_ciphertext).not.toContain(f.identity.phone);
  });

  it('requires canonical provider identity/content, not the webhook secret alone', async () => {
    const f = await fixture();
    const message = f.message('split 117 with Maya');
    f.canonical.set(message.handle, { ...message, from: '+12025550188' });
    await f.service.ingest(message);
    await f.service.processInbound();
    expect(await f.drafts()).toHaveLength(0);
    expect(await f.outbox()).toHaveLength(0);
    expect(
      (
        await db
          .selectFrom('message_inbox')
          .selectAll()
          .where('provider_account', '=', f.providerAccount)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('held');
  });

  it('requires an established channel grant, and rechecks revoked identity on every command', async () => {
    const f = await fixture({ connected: false });
    await f.say('split 117 with Maya');
    expect(await f.drafts()).toHaveLength(0);
    await f.service.createGrant(f.identity, true);
    f.invalidate();
    await f.say('split 117 with Maya');
    expect(await f.drafts()).toHaveLength(0);
    expect((await f.service.state(f.identity.accountId)).grant).toBeNull();
  });

  it('does not expose a private response to group messages or unrelated inline replies', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya', { group: true });
    expect(await f.outbox()).toHaveLength(0);
    await f.say('split 117 with Maya', { replyTo: randomUUID() });
    expect(await f.drafts()).toHaveLength(0);
    expect(await f.outbox()).toHaveLength(1);
  });

  it('chooses no default method, then binds exact confirmation to one equal expense', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya and Leo');
    let draft = (await f.drafts())[0]!;
    expect(draft.method).toBeNull();
    expect(draft.stage).toBe('method');
    await f.say('equal');
    draft = (await f.drafts())[0]!;
    expect(draft.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    await f.say('approve');
    expect(f.hooks.publishEqualSplit).not.toHaveBeenCalled();
    const confirm = await f.say(`confirm ${draft.reviewDigest!.slice(0, 12)}`);
    await f.service.ingest(confirm);
    await f.service.processInbound();
    expect(f.hooks.publishEqualSplit).toHaveBeenCalledTimes(1);
    expect(f.published.size).toBe(1);
    expect((await f.drafts())[0]?.stage).toBe('closed');
  });

  it('holds ambiguous contacts, custom/item splits and expired confirmations for web review', async () => {
    const f = await fixture();
    await f.say('split 117 with Alex');
    expect((await f.drafts())[0]?.unresolvedNames).toEqual(['Alex']);
    await f.say('with Maya and Leo');
    await f.say('items');
    expect((await f.drafts())[0]?.reviewDigest).toBeNull();
    await f.say('equal');
    const digest = (await f.drafts())[0]!.reviewDigest!;
    f.advance(5 * 60_000 + 1);
    await f.say(`confirm ${digest.slice(0, 12)}`);
    expect(f.hooks.publishEqualSplit).not.toHaveBeenCalled();
  });

  it('prevents older events from overwriting a newer draft', async () => {
    const f = await fixture();
    const older = f.message('with Maya');
    f.advance(1000);
    await f.say('split 117 with Maya and Leo');
    await f.service.ingest(older);
    await f.service.processInbound();
    expect((await f.drafts())[0]?.participants).toHaveLength(2);
  });

  it('hydrates a receipt asynchronously and retains explicit method selection', async () => {
    const f = await fixture();
    await f.say('with Maya and Leo', { mediaUrl: 'https://cdn.sendblue.co/media/synthetic.png' });
    expect(f.hooks.ingestReceipt).toHaveBeenCalledTimes(1);
    expect((await f.drafts())[0]?.receiptStatus).toBe('processing');
    await f.say('equal');
    f.receiptResult({
      status: 'review_needed',
      title: 'Synthetic Cafe',
      totalMinor: '11700',
      currency: 'USD',
      warnings: [],
    });
    expect(await f.service.processReadyReceipts()).toBe(1);
    const draft = (await f.drafts())[0]!;
    expect(draft.totalMinor).toBe('11700');
    expect(draft.method).toBe('equal');
    expect(draft.reviewDigest).toBeTruthy();
    expect(await f.service.processReadyReceipts()).toBe(0);
  });

  it('never guesses an unreadable amount or unsupported currency', async () => {
    const f = await fixture();
    await f.say('with Maya', { mediaUrl: 'https://cdn.sendblue.co/media/synthetic.png' });
    f.receiptResult({ status: 'review_needed', title: 'Cafe', totalMinor: null, currency: 'USD' });
    await f.service.processReadyReceipts();
    expect((await f.drafts())[0]?.receiptStatus).toBe('needs_review');
    expect((await f.drafts())[0]?.totalMinor).toBeNull();
  });
  it('a plausible USD total with extraction warnings requires web review and cannot be confirmed in chat', async () => {
    const f = await fixture();
    await f.say('with Maya', { mediaUrl: 'https://cdn.sendblue.co/media/synthetic.png' });
    await f.say('equal');
    f.receiptResult({
      status: 'review_needed',
      title: 'Cafe',
      totalMinor: '11700',
      currency: 'USD',
      warnings: ['The receipt components do not match the printed total.'],
    });
    await f.service.processReadyReceipts();
    const draft = (await f.drafts())[0]!;
    expect(draft.receiptStatus).toBe('needs_review');
    expect(draft.reviewDigest).toBeNull();
    await f.say('confirm aabbcc112233');
    expect(f.hooks.publishEqualSplit).not.toHaveBeenCalled();
  });

  it('STOP suppresses already queued replies before the worker can send', async () => {
    const f = await fixture();
    await f.say('hi');
    const stop = f.message('STOP');
    await f.service.ingest(stop);
    await f.service.dispatch();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect((await f.outbox())[0]?.state).toBe('suppressed');
    expect((await f.service.state(f.identity.accountId)).grant?.stopped).toBe(true);
  });

  it('an old START cannot undo a newer STOP, and a new START never renews expiry', async () => {
    const f = await fixture();
    const start = f.message('START');
    f.advance(1000);
    await f.service.ingest(f.message('STOP'));
    await f.service.ingest(start);
    expect((await f.service.state(f.identity.accountId)).grant?.stopped).toBe(true);
    const expires = (await f.service.state(f.identity.accountId)).grant?.expiresAt;
    f.advance(1000);
    await f.say('START');
    expect((await f.service.state(f.identity.accountId)).grant?.stopped).toBe(false);
    expect((await f.service.state(f.identity.accountId)).grant?.expiresAt).toBe(expires);
  });

  it('deduplicates business notifications and rechecks canonical request eligibility', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.service.enqueueRequestNotification(f.identity.accountId, requestId, 'request_created'),
      ),
    );
    expect(await f.outbox()).toHaveLength(1);
    f.setNotification(false);
    await f.service.dispatch();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect((await f.outbox())[0]?.state).toBe('suppressed');
  });

  it('requires explicit notification opt-in and keeps sending off when unconfigured', async () => {
    const f = await fixture({ consent: false, sending: false });
    await f.service.enqueueRequestNotification(
      f.identity.accountId,
      randomUUID(),
      'request_created',
    );
    expect(await f.outbox()).toHaveLength(0);
    await f.say('hi');
    expect(await f.service.dispatch()).toBe(0);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('does not automatically retry a send after unknown provider acceptance', async () => {
    const f = await fixture();
    vi.mocked(f.transport.send).mockRejectedValue(new DeliveryError('unknown'));
    await f.say('hi');
    await f.service.dispatch();
    f.advance(120_000);
    await f.service.dispatch();
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect((await f.outbox())[0]?.state).toBe('unknown');
  });

  it('a crashed sending lease becomes unknown rather than producing another send', async () => {
    const f = await fixture();
    await f.say('hi');
    const outbox = (await f.outbox())[0]!;
    await db
      .updateTable('message_outbox')
      .set({ state: 'sending', lease_token: randomUUID(), lease_until: new Date(0), attempts: 1 })
      .where('id', '=', outbox.id)
      .execute();
    await f.service.dispatch();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect((await f.outbox())[0]?.state).toBe('unknown');
  });

  it('retries definitive throttling at a bounded delay', async () => {
    const f = await fixture();
    vi.mocked(f.transport.send).mockRejectedValueOnce(new DeliveryError('rate_limited'));
    await f.say('hi');
    await f.service.dispatch();
    await f.service.dispatch();
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    f.advance(61_000);
    await f.service.dispatch();
    expect(f.transport.send).toHaveBeenCalledTimes(2);
    expect((await f.outbox())[0]?.state).toBe('sent');
  });

  it('delivery updates cannot regress a delivered message to sent or create a payment', async () => {
    const f = await fixture();
    await f.say('hi');
    await f.service.dispatch();
    const outgoing = (await f.outbox())[0]!;
    await f.say('', { handle: outgoing.provider_handle!, outbound: true, status: 'DELIVERED' });
    f.advance(1000);
    await f.say('', { handle: outgoing.provider_handle!, outbound: true, status: 'SENT' });
    expect((await f.outbox())[0]?.state).toBe('delivered');
    expect(f.hooks.publishEqualSplit).not.toHaveBeenCalled();
  });

  it('concurrent workers submit each queued message once', async () => {
    const f = await fixture();
    await f.say('hi');
    await Promise.all(Array.from({ length: 8 }, () => f.service.dispatch()));
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });

  it('revocation and expiry block queued messages without deleting account drafts', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya');
    await f.service.revokeGrant(f.identity.accountId);
    await f.service.dispatch();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(await f.drafts()).toHaveLength(1);
  });

  it('resumes a reserved publication with the same permanent key after a lost result', async () => {
    const f = await fixture();
    await f.say('split 117 with Maya and Leo');
    await f.say('equal');
    const draft = (await f.drafts())[0]!;
    let lost = true;
    vi.mocked(f.hooks.publishEqualSplit!).mockImplementation(async (input) => {
      if (!f.published.has(input.draftId)) f.published.set(input.draftId, randomUUID());
      if (lost) {
        lost = false;
        throw new Error('Lost commit reply');
      }
      return { expenseId: f.published.get(input.draftId)! };
    });
    await f.say(`confirm ${draft.reviewDigest!.slice(0, 12)}`);
    expect(f.published.size).toBe(1);
    await f.say('new split');
    expect((await f.drafts())[0]?.id).toBe(draft.id);
    f.advance(6 * 60_000);
    await f.service.processInbound();
    expect(f.published.size).toBe(1);
    expect(f.hooks.publishEqualSplit).toHaveBeenCalledTimes(2);
    expect((await f.drafts())[0]?.stage).toBe('closed');
  });

  it('a canonical START mismatch cannot resume notifications', async () => {
    const f = await fixture();
    await f.say('STOP');
    f.advance(1000);
    const start = f.message('START');
    f.canonical.set(start.handle, { ...start, content: 'other' });
    await f.service.ingest(start);
    await f.service.processInbound();
    expect((await f.service.state(f.identity.accountId)).grant?.stopped).toBe(true);
  });

  it('messages preceding a new channel grant cannot borrow that grant’s authority', async () => {
    const f = await fixture({ connected: false });
    const old = f.message('split 117 with Maya');
    f.advance(1000);
    await f.service.createGrant(f.identity, true);
    await f.service.ingest(old);
    await f.service.processInbound();
    expect(await f.drafts()).toHaveLength(0);
  });

  it('purges expired private contents but retains deduplication and unknown-delivery metadata', async () => {
    const f = await fixture();
    vi.mocked(f.transport.send).mockRejectedValue(new DeliveryError('unknown'));
    await f.say('split 117 with Maya');
    await f.service.dispatch();
    f.advance(8 * 24 * 60 * 60_000);
    await f.service.purgeExpired();
    expect(await f.drafts()).toHaveLength(0);
    const inbox = await db
      .selectFrom('message_inbox')
      .selectAll()
      .where('provider_account', '=', f.providerAccount)
      .executeTakeFirstOrThrow();
    expect(inbox.payload_ciphertext).toBeNull();
    const outgoing = (await f.outbox())[0]!;
    expect(outgoing.state).toBe('unknown');
    expect(outgoing.payload_ciphertext).toBeNull();
    const grant = await db
      .selectFrom('message_grants')
      .select('phone_ciphertext')
      .where('provider_account', '=', f.providerAccount)
      .executeTakeFirstOrThrow();
    expect(grant.phone_ciphertext).toBeNull();
  });

  it('old text drafts and an unavailable receipt cannot starve later receipt hydration', async () => {
    const providerAccount = randomUUID();
    const textOnly = await fixture({ providerAccount });
    await textOnly.say('split 117 with Maya');
    const unavailable = await fixture({ providerAccount });
    await unavailable.say('with Maya', { mediaUrl: 'https://cdn.sendblue.co/media/a.png' });
    const f = await fixture({ providerAccount });
    await f.say('with Maya', { mediaUrl: 'https://cdn.sendblue.co/media/b.png' });
    f.receiptResult({
      status: 'review_needed',
      title: 'Cafe',
      totalMinor: '11700',
      currency: 'USD',
      warnings: [],
    });
    // First batch rotates the older, ineligible receipt without changing its
    // product updatedAt. The next bounded batch reaches this account’s receipt.
    await f.service.processReadyReceipts(1);
    await f.service.processReadyReceipts(1);
    expect((await f.drafts())[0]?.receiptStatus).toBe('ready');
  });
});
