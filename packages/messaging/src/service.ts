import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { PhoneVault } from '@tallie/channels';
import type { CreateExpenseInput } from '@tallie/db/contracts';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  DeliveryError,
  MessagingError,
  type InboundMessage,
  type MessageDraft,
  type MessageIdentity,
  type MessagingHooks,
  type MessagingTransport,
  type MessagesState,
} from './contracts';
import { draftReviewDigest, equalReviewText, parseIntent } from './intent';
import { downloadReceiptMedia, type ReceiptMedia } from './media';
import { canonicalMessageMatches, messageHash, optCommand, phoneSchema } from './normalization';
import type { MessagingDatabase } from './schema';

type Grant = Selectable<MessagingDatabase['message_grants']>;
type Inbox = Selectable<MessagingDatabase['message_inbox']>;
type DraftRow = Selectable<MessagingDatabase['message_drafts']>;
type Outbox = Selectable<MessagingDatabase['message_outbox']>;
type Tx = Transaction<MessagingDatabase>;
const DAY = 24 * 60 * 60_000;
const GRANT_LIFETIME = 7 * DAY;
const CLEAN_LABEL = /^[^\x00-\x1f\u202a-\u202e\u2066-\u2069]{1,100}$/;

export function messageGrantLockKey(providerAccount: string, phoneHash: string): string {
  return `message-grant:${providerAccount}:${phoneHash}`;
}

export interface MessagingOptions {
  providerAccount: string;
  sendingLine: string;
  encryptionKey: string;
  appOrigin: string;
  sendingEnabled: boolean;
  now?: () => Date;
  downloadMedia?: (url: string) => Promise<ReceiptMedia>;
}

export class MessagingService {
  private readonly vault: PhoneVault;
  private readonly now: () => Date;
  private readonly origin: string;
  private readonly downloadMedia: (url: string) => Promise<ReceiptMedia>;

  constructor(
    private readonly db: Kysely<MessagingDatabase>,
    private readonly transport: MessagingTransport,
    private readonly hooks: MessagingHooks,
    private readonly options: MessagingOptions,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(options.encryptionKey))
      throw new MessagingError('MESSAGING_KEY_REQUIRED', 503);
    this.vault = new PhoneVault(
      Buffer.from(
        hkdfSync('sha256', Buffer.from(options.encryptionKey, 'hex'), 'tallie', 'messaging-v1', 32),
      ).toString('hex'),
    );
    phoneSchema.parse(options.sendingLine);
    const url = new URL(options.appOrigin);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:'))
    )
      throw new MessagingError('MESSAGING_ORIGIN_INVALID', 503);
    this.origin = url.origin;
    this.now = options.now ?? (() => new Date());
    this.downloadMedia = options.downloadMedia ?? downloadReceiptMedia;
  }

  private identity(grant: Grant): MessageIdentity {
    if (!grant.phone_ciphertext) throw new MessagingError('CHANNEL_RECONNECT_REQUIRED', 403);
    return {
      accountId: grant.account_id,
      personId: grant.person_id,
      sessionId: grant.session_id,
      bindingEpoch: grant.binding_epoch,
      phone: this.vault.open(grant.phone_ciphertext, `grant:${grant.id}`),
    };
  }

  private async eligible(grant: Grant): Promise<boolean> {
    return (
      !grant.revoked_at &&
      grant.expires_at > this.now() &&
      (await this.hooks.validateIdentity(this.identity(grant)))
    );
  }

  /** Called only after the web adapter establishes a real session and records consent. */
  async createGrant(identity: MessageIdentity, notifications: boolean): Promise<MessagesState> {
    phoneSchema.parse(identity.phone);
    if (!(await this.hooks.validateIdentity(identity)))
      throw new MessagingError('CHANNEL_IDENTITY_REQUIRED', 403);
    const phoneHash = this.vault.lookup(identity.phone);
    const now = this.now();
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${messageGrantLockKey(this.options.providerAccount, phoneHash)}, 0))`.execute(
        tx,
      );
      const existing = await tx
        .selectFrom('message_grants')
        .selectAll()
        .where('provider_account', '=', this.options.providerAccount)
        .where('phone_hash', '=', phoneHash)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (existing && existing.account_id !== identity.accountId && existing.expires_at > now)
        throw new MessagingError('CHANNEL_BINDING_CONFLICT', 409);
      if (
        existing &&
        existing.account_id === identity.accountId &&
        existing.session_id === identity.sessionId &&
        existing.person_id === identity.personId &&
        existing.binding_epoch === identity.bindingEpoch &&
        existing.notifications === notifications &&
        existing.expires_at > now
      )
        return;
      await tx
        .updateTable('message_grants')
        .set({ revoked_at: now })
        .where('provider_account', '=', this.options.providerAccount)
        .where((eb) =>
          eb.or([eb('phone_hash', '=', phoneHash), eb('account_id', '=', identity.accountId)]),
        )
        .where('revoked_at', 'is', null)
        .execute();
      const id = randomUUID();
      await tx
        .insertInto('message_grants')
        .values({
          id,
          provider_account: this.options.providerAccount,
          account_id: identity.accountId,
          person_id: identity.personId,
          session_id: identity.sessionId,
          binding_epoch: identity.bindingEpoch,
          phone_hash: phoneHash,
          phone_ciphertext: this.vault.seal(identity.phone, `grant:${id}`),
          sending_line: this.options.sendingLine,
          notifications,
          consent_version: 'messages-imessage-sms-v1',
          created_at: now,
          expires_at: new Date(now.getTime() + GRANT_LIFETIME),
          revoked_at: null,
          last_message_at: null,
        })
        .execute();
    });
    return this.state(identity.accountId);
  }

  async revokeGrant(accountId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('message_grants')
        .select('phone_hash')
        .where('account_id', '=', accountId)
        .where('provider_account', '=', this.options.providerAccount)
        .where('revoked_at', 'is', null)
        .orderBy('phone_hash', 'asc')
        .execute();
      for (const grant of current)
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${messageGrantLockKey(this.options.providerAccount, grant.phone_hash)}, 0))`.execute(
          tx,
        );
      const revoked = await tx
        .updateTable('message_grants')
        .set({ revoked_at: this.now() })
        .where('account_id', '=', accountId)
        .where('provider_account', '=', this.options.providerAccount)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      if (revoked.length)
        await tx
          .updateTable('message_outbox')
          .set({ state: 'suppressed' })
          .where(
            'grant_id',
            'in',
            revoked.map((r) => r.id),
          )
          .where('state', '=', 'queued')
          .execute();
    });
  }

  private openDraft(row: DraftRow): MessageDraft {
    const value = JSON.parse(
      this.vault.open(row.payload_ciphertext, `draft:${row.id}`),
    ) as MessageDraft;
    return {
      ...value,
      publicationPending: !!row.web_publication_hash && !value.expenseId,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async state(accountId: string): Promise<MessagesState> {
    const grant = await this.db
      .selectFrom('message_grants')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('provider_account', '=', this.options.providerAccount)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', this.now())
      .executeTakeFirst();
    const usable = grant && (await this.eligible(grant)) ? grant : null;
    const preference = usable
      ? await this.db
          .selectFrom('message_preferences')
          .select('stopped_at')
          .where('provider_account', '=', this.options.providerAccount)
          .where('phone_hash', '=', usable.phone_hash)
          .executeTakeFirst()
      : null;
    const drafts = await this.db
      .selectFrom('message_drafts')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('expires_at', '>', this.now())
      .orderBy('updated_at', 'desc')
      .limit(20)
      .execute();
    return {
      available: true,
      sendingEnabled: this.options.sendingEnabled,
      grant: usable
        ? {
            id: usable.id,
            maskedPhone: `••• ••• ${this.identity(usable).phone.slice(-4)}`,
            expiresAt: usable.expires_at.toISOString(),
            stopped: !!preference?.stopped_at,
            notifications: usable.notifications,
          }
        : null,
      drafts: drafts.map((row) => this.openDraft(row)),
    };
  }

  async getDraft(accountId: string, id: string): Promise<MessageDraft> {
    const row = await this.db
      .selectFrom('message_drafts')
      .selectAll()
      .where('id', '=', id)
      .where('account_id', '=', accountId)
      .where('expires_at', '>', this.now())
      .executeTakeFirst();
    if (!row) throw new MessagingError('MESSAGE_DRAFT_NOT_FOUND', 404);
    return this.openDraft(row);
  }

  /** Trusted established-web-session boundary. Publication keeps the same
   * permanent domain key as chat, including across lost responses and retries. */
  async publishDraftFromWeb(
    accountId: string,
    draftId: string,
    version: number,
    inputHash: string,
    input: CreateExpenseInput,
    publish: () => Promise<{ expenseId: string }>,
  ): Promise<{ expenseId: string }> {
    if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new MessagingError('INVALID_PUBLICATION_HASH');
    if (createHash('sha256').update(JSON.stringify(input)).digest('hex') !== inputHash)
      throw new MessagingError('INVALID_PUBLICATION_HASH');
    const reservation = await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('message_drafts')
        .selectAll()
        .where('id', '=', draftId)
        .where('account_id', '=', accountId)
        .where('expires_at', '>', this.now())
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new MessagingError('MESSAGE_DRAFT_NOT_FOUND', 404);
      if (row.version !== version) throw new MessagingError('MESSAGE_DRAFT_CHANGED', 409);
      const draft = this.openDraft(row);
      if (row.publishing_message_id)
        throw new MessagingError('MESSAGE_PUBLICATION_IN_PROGRESS', 409);
      if (row.web_publication_hash && row.web_publication_hash !== inputHash)
        throw new MessagingError('PUBLICATION_RETRY_CONFLICT', 409);
      if (draft.expenseId) return { expenseId: draft.expenseId };
      if (row.closed_at) throw new MessagingError('MESSAGE_DRAFT_CLOSED', 409);
      draft.publicationPending = true;
      draft.publicationInput = input;
      await tx
        .updateTable('message_drafts')
        .set({
          web_publication_hash: inputHash,
          payload_ciphertext: this.vault.seal(JSON.stringify(draft), `draft:${draft.id}`),
        })
        .where('id', '=', draftId)
        .execute();
      return null;
    });
    if (reservation) return reservation;
    const result = await publish();
    await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('message_drafts')
        .selectAll()
        .where('id', '=', draftId)
        .where('account_id', '=', accountId)
        .where('web_publication_hash', '=', inputHash)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const draft = this.openDraft(row);
      if (draft.expenseId && draft.expenseId !== result.expenseId)
        throw new MessagingError('PUBLICATION_RESULT_CONFLICT', 409);
      draft.expenseId = result.expenseId;
      draft.stage = 'closed';
      draft.publicationPending = false;
      draft.title = input.title;
      draft.totalMinor = input.totalMinor;
      draft.method = input.method;
      await tx
        .updateTable('message_drafts')
        .set({
          payload_ciphertext: this.vault.seal(JSON.stringify(draft), `draft:${draft.id}`),
          closed_at: this.now(),
          receipt_pending: false,
          updated_at: this.now(),
        })
        .where('id', '=', draftId)
        .execute();
    });
    return result;
  }

  async resumeDraftFromWeb(
    accountId: string,
    draftId: string,
    publish: (input: CreateExpenseInput) => Promise<{ expenseId: string }>,
  ): Promise<{ expenseId: string }> {
    const row = await this.db
      .selectFrom('message_drafts')
      .selectAll()
      .where('id', '=', draftId)
      .where('account_id', '=', accountId)
      .where('expires_at', '>', this.now())
      .executeTakeFirst();
    if (!row) throw new MessagingError('MESSAGE_DRAFT_NOT_FOUND', 404);
    const draft = this.openDraft(row);
    if (draft.expenseId) return { expenseId: draft.expenseId };
    if (!row.web_publication_hash || !draft.publicationInput)
      throw new MessagingError('NO_PENDING_WEB_PUBLICATION', 409);
    const input = draft.publicationInput;
    return this.publishDraftFromWeb(
      accountId,
      draftId,
      row.version,
      row.web_publication_hash,
      input,
      () => publish(input),
    );
  }

  /** Authenticated webhook intake. Expensive/provider work is deferred to the worker. */
  async ingest(message: InboundMessage): Promise<{ duplicate: boolean }> {
    if (message.line !== this.options.sendingLine)
      throw new MessagingError('WRONG_RECEIVING_LINE', 403);
    const now = this.now();
    const phoneHash = this.vault.lookup(message.from);
    const command = !message.outbound ? optCommand(message.content) : null;
    const stale = new Date(message.occurredAt).getTime() < now.getTime() - GRANT_LIFETIME;
    const hash = messageHash(
      message.outbound
        ? message
        : { ...message, updatedAt: message.occurredAt, status: 'RECEIVED', optedOut: false },
    );
    const key = message.outbound
      ? `status:${message.handle}:${message.status}:${message.updatedAt}:${hash}`
      : `inbound:${message.handle}`;
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-intake:${this.options.providerAccount}`}, 0))`.execute(
        tx,
      );
      const duplicate = await tx
        .selectFrom('message_inbox')
        .select('payload_hash')
        .where('provider_account', '=', this.options.providerAccount)
        .where('event_key', '=', key)
        .executeTakeFirst();
      if (duplicate && duplicate.payload_hash !== hash)
        throw new MessagingError('MESSAGE_REPLAY_CONFLICT', 409);
      if (!duplicate && !command && !message.optedOut) {
        const budget = await tx
          .selectFrom('message_inbox')
          .select((eb) => [
            eb.fn.countAll<string>().as('total'),
            eb.fn.countAll<string>().filterWhere('phone_hash', '=', phoneHash).as('phone'),
          ])
          .where('provider_account', '=', this.options.providerAccount)
          .where('created_at', '>=', new Date(now.getTime() - DAY))
          .executeTakeFirstOrThrow();
        if (Number(budget.total) >= 2000 || Number(budget.phone) >= 200)
          throw new MessagingError('MESSAGING_INTAKE_LIMIT', 429);
      }
      // STOP is applied during intake, ahead of queued commands or receipt parsing.
      if (command === 'stop' || message.optedOut) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${messageGrantLockKey(this.options.providerAccount, phoneHash)}, 0))`.execute(
          tx,
        );
        const stopped = true;
        const appliedStop = await tx
          .insertInto('message_preferences')
          .values({
            provider_account: this.options.providerAccount,
            phone_hash: phoneHash,
            stopped_at: stopped ? now : null,
            command_at: new Date(message.occurredAt),
          })
          .onConflict((oc) =>
            oc
              .columns(['provider_account', 'phone_hash'])
              .doUpdateSet({
                stopped_at: stopped ? now : null,
                command_at: new Date(message.occurredAt),
              })
              .where('message_preferences.command_at', '<=', new Date(message.occurredAt)),
          )
          .returning('phone_hash')
          .executeTakeFirst();
        if (appliedStop) {
          const grants = await tx
            .selectFrom('message_grants')
            .select('id')
            .where('phone_hash', '=', phoneHash)
            .where('provider_account', '=', this.options.providerAccount)
            .execute();
          if (grants.length)
            await tx
              .updateTable('message_outbox')
              .set({ state: 'suppressed' })
              .where(
                'grant_id',
                'in',
                grants.map((g) => g.id),
              )
              .where('state', '=', 'queued')
              .execute();
        }
      }
      const id = randomUUID();
      const inserted = await tx
        .insertInto('message_inbox')
        .values({
          id,
          provider_account: this.options.providerAccount,
          event_key: key,
          message_handle: message.handle,
          phone_hash: phoneHash,
          payload_hash: hash,
          payload_ciphertext:
            message.group || stale ? null : this.vault.seal(JSON.stringify(message), `inbox:${id}`),
          kind: message.outbound ? 'status' : 'inbound',
          state:
            command === 'stop' || message.optedOut
              ? 'done'
              : message.group || stale
                ? 'ignored'
                : 'queued',
          lease_token: null,
          lease_until: null,
          available_at: now,
          error_code: null,
          occurred_at: new Date(message.occurredAt),
          created_at: now,
          expires_at: new Date(now.getTime() + GRANT_LIFETIME),
        })
        .onConflict((oc) => oc.columns(['provider_account', 'event_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) {
        const original = await tx
          .selectFrom('message_inbox')
          .select('payload_hash')
          .where('provider_account', '=', this.options.providerAccount)
          .where('event_key', '=', key)
          .executeTakeFirstOrThrow();
        if (original.payload_hash !== hash)
          throw new MessagingError('MESSAGE_REPLAY_CONFLICT', 409);
      }
      return { duplicate: !inserted };
    });
  }

  private async queue(
    tx: Tx,
    grant: Grant,
    semanticKey: string,
    content: string,
    kind: 'reply' | 'notification' = 'reply',
    reference: string | null = null,
  ): Promise<void> {
    if (!content || content.length > 4000) throw new MessagingError('INVALID_MESSAGE_CONTENT');
    const id = randomUUID();
    const now = this.now();
    await tx
      .insertInto('message_outbox')
      .values({
        id,
        provider_account: this.options.providerAccount,
        grant_id: grant.id,
        semantic_key: semanticKey,
        kind,
        reference,
        payload_ciphertext: this.vault.seal(content, `outbox:${id}`),
        provider_handle: null,
        lease_token: null,
        lease_until: null,
        available_at: now,
        provider_updated_at: null,
        created_at: now,
        expires_at: new Date(Math.min(grant.expires_at.getTime(), now.getTime() + DAY)),
      })
      .onConflict((oc) => oc.columns(['provider_account', 'semantic_key']).doNothing())
      .execute();
  }

  async enqueueRequestNotification(
    accountId: string,
    requestId: string,
    semanticKey: string,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(semanticKey) || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))
      throw new MessagingError('INVALID_NOTIFICATION_REFERENCE');
    await this.db.transaction().execute(async (tx) => {
      const grant = await tx
        .selectFrom('message_grants')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('provider_account', '=', this.options.providerAccount)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', this.now())
        .where('notifications', '=', true)
        .forUpdate()
        .executeTakeFirst();
      if (!grant || !(await this.eligible(grant))) return;
      await this.queue(
        tx,
        grant,
        `request:${accountId}:${semanticKey}`,
        `A request is ready in Tallie. Review it securely: ${this.origin}/?request=${encodeURIComponent(requestId)}\nReply STOP to pause messages.`,
        'notification',
        requestId,
      );
    });
  }

  private async claimInbox(): Promise<Inbox | undefined> {
    const now = this.now();
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('message_inbox')
        .set({ state: 'queued', lease_token: null, lease_until: null })
        .where('provider_account', '=', this.options.providerAccount)
        .where('state', '=', 'processing')
        .where('lease_until', '<=', now)
        .where('attempts', '<', 3)
        .execute();
      await tx
        .updateTable('message_inbox')
        .set({
          state: 'held',
          error_code: 'PROCESSING_INTERRUPTED',
          lease_token: null,
          lease_until: null,
        })
        .where('provider_account', '=', this.options.providerAccount)
        .where('state', '=', 'processing')
        .where('lease_until', '<=', now)
        .where('attempts', '>=', 3)
        .execute();
      const row = await tx
        .selectFrom('message_inbox')
        .selectAll()
        .where('provider_account', '=', this.options.providerAccount)
        .where('state', '=', 'queued')
        .where('available_at', '<=', now)
        .where('expires_at', '>', now)
        .orderBy('occurred_at', 'asc')
        .orderBy('created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (!row) return;
      return tx
        .updateTable('message_inbox')
        .set({
          state: 'processing',
          attempts: row.attempts + 1,
          lease_token: randomUUID(),
          lease_until: new Date(now.getTime() + 120_000),
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  private async finishInbox(
    row: Inbox,
    state: 'done' | 'held' | 'ignored',
    errorCode: string | null = null,
  ) {
    await this.db
      .updateTable('message_inbox')
      .set({ state, error_code: errorCode, lease_token: null, lease_until: null })
      .where('id', '=', row.id)
      .where('lease_token', '=', row.lease_token)
      .execute();
  }

  async processInbound(limit = 10): Promise<number> {
    let processed = 0;
    for (let i = 0; i < Math.min(limit, 50); i++) {
      const row = await this.claimInbox();
      if (!row) break;
      try {
        if (!row.payload_ciphertext) {
          await this.finishInbox(row, 'ignored');
          continue;
        }
        const message = JSON.parse(
          this.vault.open(row.payload_ciphertext, `inbox:${row.id}`),
        ) as InboundMessage;
        if (row.kind === 'status') await this.applyStatus(row, message);
        else {
          const canonical = await this.transport.retrieve(message.handle);
          if (!canonicalMessageMatches(message, canonical)) {
            await this.finishInbox(row, 'held', 'CANONICAL_MESSAGE_MISMATCH');
          } else {
            if (canonical.optedOut) await this.ingest({ ...message, optedOut: true });
            if (optCommand(message.content) === 'start' && !canonical.optedOut) {
              // Resuming consent requires an authenticated provider read. A
              // static webhook secret alone may stop delivery, never restart it.
              await this.db.transaction().execute(async (tx) => {
                await sql`SELECT pg_advisory_xact_lock(hashtextextended(${messageGrantLockKey(this.options.providerAccount, row.phone_hash)}, 0))`.execute(
                  tx,
                );
                await tx
                  .insertInto('message_preferences')
                  .values({
                    provider_account: this.options.providerAccount,
                    phone_hash: row.phone_hash,
                    stopped_at: null,
                    command_at: new Date(message.occurredAt),
                  })
                  .onConflict((oc) =>
                    oc
                      .columns(['provider_account', 'phone_hash'])
                      .doUpdateSet({ stopped_at: null, command_at: new Date(message.occurredAt) })
                      .where('message_preferences.command_at', '<', new Date(message.occurredAt)),
                  )
                  .execute();
              });
            }
            await this.applyMessage(row, message);
          }
        }
      } catch (error) {
        const code =
          error instanceof MessagingError ? error.code : 'MESSAGE_PROCESSING_UNAVAILABLE';
        await this.db
          .updateTable('message_inbox')
          .set({
            state: row.attempts < 3 ? 'queued' : 'held',
            error_code: code,
            available_at: new Date(this.now().getTime() + row.attempts * 10_000),
            lease_token: null,
            lease_until: null,
          })
          .where('id', '=', row.id)
          .where('lease_token', '=', row.lease_token)
          .execute();
      }
      processed++;
    }
    return processed;
  }

  private async applyStatus(row: Inbox, message: InboundMessage) {
    await this.db.transaction().execute(async (tx) => {
      const outgoing = await tx
        .selectFrom('message_outbox')
        .innerJoin('message_grants', 'message_grants.id', 'message_outbox.grant_id')
        .selectAll('message_outbox')
        .select(['message_grants.phone_hash', 'message_grants.sending_line'])
        .where('message_outbox.provider_account', '=', this.options.providerAccount)
        .where('provider_handle', '=', message.handle)
        .forUpdate('message_outbox')
        .executeTakeFirst();
      if (
        outgoing &&
        outgoing.phone_hash === row.phone_hash &&
        outgoing.sending_line === message.line
      ) {
        const updated = new Date(message.updatedAt);
        const state =
          message.status === 'DELIVERED' || message.status === 'READ'
            ? 'delivered'
            : message.status === 'SENT'
              ? 'sent'
              : ['ERROR', 'FAILED'].includes(message.status)
                ? 'failed'
                : null;
        if (
          state &&
          outgoing.state !== 'delivered' &&
          (!outgoing.provider_updated_at || updated >= outgoing.provider_updated_at)
        ) {
          await tx
            .updateTable('message_outbox')
            .set({ state, provider_updated_at: updated })
            .where('id', '=', outgoing.id)
            .execute();
        }
      }
      await tx
        .updateTable('message_inbox')
        .set({
          state: outgoing ? 'done' : 'held',
          error_code: outgoing ? null : 'UNMATCHED_DELIVERY_STATUS',
          lease_token: null,
          lease_until: null,
        })
        .where('id', '=', row.id)
        .where('lease_token', '=', row.lease_token)
        .execute();
    });
  }

  private async saveDraft(
    tx: Tx,
    grant: Grant,
    draft: MessageDraft,
    exists: boolean,
  ): Promise<void> {
    const encrypted = this.vault.seal(JSON.stringify(draft), `draft:${draft.id}`);
    if (exists)
      await tx
        .updateTable('message_drafts')
        .set({
          version: draft.version,
          payload_ciphertext: encrypted,
          closed_at: draft.stage === 'closed' ? this.now() : null,
          receipt_pending: draft.receiptStatus === 'processing' && draft.stage !== 'closed',
          next_receipt_check_at: this.now(),
          updated_at: this.now(),
        })
        .where('id', '=', draft.id)
        .where('account_id', '=', grant.account_id)
        .execute();
    else
      await tx
        .insertInto('message_drafts')
        .values({
          id: draft.id,
          account_id: grant.account_id,
          grant_id: grant.id,
          version: draft.version,
          payload_ciphertext: encrypted,
          closed_at: null,
          publishing_message_id: null,
          web_publication_hash: null,
          receipt_pending: draft.receiptStatus === 'processing',
          next_receipt_check_at: this.now(),
          created_at: this.now(),
          updated_at: this.now(),
          expires_at: new Date(draft.expiresAt),
        })
        .execute();
  }

  private newDraft(): MessageDraft {
    const now = this.now();
    return {
      id: randomUUID(),
      version: 1,
      title: 'Shared moment',
      totalMinor: null,
      method: null,
      participantNames: [],
      participants: [],
      unresolvedNames: [],
      receiptId: null,
      receiptStatus: null,
      expenseId: null,
      reviewDigest: null,
      reviewExpiresAt: null,
      stage: 'details',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + GRANT_LIFETIME).toISOString(),
    };
  }

  private async prepareReview(draft: MessageDraft, identity: MessageIdentity): Promise<string> {
    const link = `${this.origin}/?messageDraft=${draft.id}`;
    if (draft.receiptStatus === 'processing')
      return 'Your receipt is being read. You can tell me who joined you with “with Maya and Leo”.';
    if (
      draft.receiptStatus === 'needs_review' ||
      draft.receiptStatus === 'failed' ||
      !draft.totalMinor
    ) {
      draft.stage = 'details';
      return `Let’s check the receipt and total first: ${link}`;
    }
    if (
      !draft.participantNames.length ||
      draft.unresolvedNames.length ||
      !draft.participants.length
    ) {
      draft.stage = 'participants';
      return draft.unresolvedNames.length
        ? `I couldn’t identify everyone uniquely. Choose the exact friends in Tallie: ${link}`
        : 'Who joined you? Reply “with Maya and Leo”, using the names saved in your Tallie friends.';
    }
    if (!draft.method) {
      draft.stage = 'method';
      return 'How would you like to split this one? Reply equal, items, or custom.';
    }
    draft.stage = 'review';
    if (draft.method !== 'equal')
      return `Choose everyone’s items or amounts, then review your split in Tallie: ${link}`;
    draft.reviewDigest = draftReviewDigest(draft, identity.personId);
    draft.reviewExpiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    return `${equalReviewText(draft, identity.personId)}\nEdit instead: ${link}`;
  }

  private async applyMessage(row: Inbox, message: InboundMessage): Promise<void> {
    const grant = await this.db
      .selectFrom('message_grants')
      .selectAll()
      .where('provider_account', '=', this.options.providerAccount)
      .where('phone_hash', '=', row.phone_hash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', this.now())
      .executeTakeFirst();
    if (
      !grant ||
      new Date(message.occurredAt) < grant.created_at ||
      !(await this.eligible(grant))
    ) {
      await this.finishInbox(row, 'ignored', 'CHANNEL_RECONNECT_REQUIRED');
      return;
    }
    const identity = this.identity(grant);
    const preference = await this.db
      .selectFrom('message_preferences')
      .select('stopped_at')
      .where('provider_account', '=', this.options.providerAccount)
      .where('phone_hash', '=', row.phone_hash)
      .executeTakeFirst();
    if (preference?.stopped_at) {
      await this.finishInbox(row, 'ignored', 'CHANNEL_STOPPED');
      return;
    }
    const intent = parseIntent(message.content);
    // Downloading and image intake happen outside the conversation transaction.
    // The hook must use this provider handle as its durable idempotency key.
    let receipt: { receiptId: string } | null = null;
    let mediaError = false;
    if (message.mediaUrl) {
      if (!this.hooks.ingestReceipt) mediaError = true;
      else {
        try {
          const bytes = await this.downloadMedia(message.mediaUrl);
          receipt = await this.hooks.ingestReceipt({
            identity,
            draftId: row.id,
            messageId: message.handle,
            ...bytes,
          });
        } catch (error) {
          if (!(error instanceof MessagingError)) throw error;
          mediaError = true;
        }
      }
    }
    let publication: { draft: MessageDraft; grant: Grant } | undefined;
    await this.db.transaction().execute(async (tx) => {
      const activeLease = await tx
        .selectFrom('message_inbox')
        .select('id')
        .where('id', '=', row.id)
        .where('lease_token', '=', row.lease_token)
        .where('state', '=', 'processing')
        .forUpdate()
        .executeTakeFirst();
      if (!activeLease) return;
      const current = await tx
        .selectFrom('message_grants')
        .selectAll()
        .where('id', '=', grant.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const preference = await tx
        .selectFrom('message_preferences')
        .select('stopped_at')
        .where('provider_account', '=', this.options.providerAccount)
        .where('phone_hash', '=', row.phone_hash)
        .executeTakeFirst();
      const occurrence = new Date(message.occurredAt);
      if (
        !(await this.eligible(current)) ||
        preference?.stopped_at ||
        (current.last_message_at && occurrence < current.last_message_at)
      ) {
        await tx
          .updateTable('message_inbox')
          .set({
            state: 'ignored',
            error_code: 'STALE_OR_RESTRICTED_CHANNEL',
            lease_token: null,
            lease_until: null,
          })
          .where('id', '=', row.id)
          .where('lease_token', '=', row.lease_token)
          .execute();
        return;
      }
      if (message.replyTo) {
        const previous = await tx
          .selectFrom('message_inbox')
          .select('id')
          .where('provider_account', '=', this.options.providerAccount)
          .where('message_handle', '=', message.replyTo)
          .where('phone_hash', '=', row.phone_hash)
          .executeTakeFirst();
        const sent = await tx
          .selectFrom('message_outbox')
          .select('id')
          .where('provider_handle', '=', message.replyTo)
          .where('grant_id', '=', current.id)
          .executeTakeFirst();
        if (!previous && !sent) {
          await this.queue(
            tx,
            current,
            `reply:${row.id}`,
            `I couldn’t match that reply to this conversation. Continue securely in Tallie: ${this.origin}`,
          );
          await tx
            .updateTable('message_inbox')
            .set({
              state: 'held',
              error_code: 'UNBOUND_INLINE_REPLY',
              lease_token: null,
              lease_until: null,
            })
            .where('id', '=', row.id)
            .where('lease_token', '=', row.lease_token)
            .execute();
          return;
        }
      }
      await tx
        .updateTable('message_drafts')
        .set({ closed_at: this.now() })
        .where('grant_id', '=', current.id)
        .where('closed_at', 'is', null)
        .where('expires_at', '<=', this.now())
        .execute();
      let draftRow = await tx
        .selectFrom('message_drafts')
        .selectAll()
        .where('grant_id', '=', current.id)
        .where('closed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (
        draftRow?.web_publication_hash ||
        (draftRow?.publishing_message_id && draftRow.publishing_message_id !== row.id)
      ) {
        await this.queue(
          tx,
          current,
          `reply:${row.id}`,
          `Your reviewed split is being created. You can check it in Tallie: ${this.origin}`,
        );
        await tx
          .updateTable('message_inbox')
          .set({ state: 'done', lease_token: null, lease_until: null })
          .where('id', '=', row.id)
          .where('lease_token', '=', row.lease_token)
          .execute();
        return;
      }
      if (intent.type === 'new' || (intent.type === 'split' && draftRow) || (receipt && draftRow)) {
        if (draftRow)
          await tx
            .updateTable('message_drafts')
            .set({ closed_at: this.now() })
            .where('id', '=', draftRow.id)
            .execute();
        draftRow = undefined;
      }
      const draft = draftRow ? this.openDraft(draftRow) : this.newDraft();
      let save = false;
      let response = '';
      if (intent.type === 'payment') {
        response = `Open Tallie to review and explicitly approve a payment: ${this.origin}\nMessages and reactions never move money.`;
      } else if (mediaError) {
        response = `I couldn’t safely open this photo. Upload a JPEG, PNG, or WebP receipt in Tallie: ${this.origin}`;
      } else if (intent.type === 'confirm' && !receipt) {
        if (
          !draftRow ||
          draft.method !== 'equal' ||
          !draft.totalMinor ||
          !draft.reviewDigest ||
          !draft.reviewExpiresAt ||
          (!draftRow.publishing_message_id && new Date(draft.reviewExpiresAt) <= this.now()) ||
          draft.reviewDigest.slice(0, 12) !== intent.token ||
          draftReviewDigest(draft, identity.personId) !== draft.reviewDigest ||
          !this.hooks.publishEqualSplit
        ) {
          response = `That review has changed or expired. Reply “review” for a fresh summary, or open Tallie: ${this.origin}`;
        } else {
          await tx
            .updateTable('message_drafts')
            .set({ publishing_message_id: row.id })
            .where('id', '=', draft.id)
            .execute();
          publication = { draft, grant: current };
          return;
        }
      } else if (
        receipt ||
        ['split', 'participants', 'method', 'review', 'new'].includes(intent.type)
      ) {
        if (draftRow) draft.version++;
        draft.reviewDigest = null;
        draft.reviewExpiresAt = null;
        if (receipt) {
          draft.receiptId = receipt.receiptId;
          draft.receiptStatus = 'processing';
        }
        if (intent.type === 'split') {
          draft.totalMinor = intent.totalMinor;
          draft.title = intent.title;
          draft.participantNames = intent.names;
        }
        if (intent.type === 'participants') draft.participantNames = intent.names;
        if (intent.type === 'method') draft.method = intent.method;
        if (draft.participantNames.length) {
          const resolved = await this.hooks.resolveContacts(identity, draft.participantNames);
          if (
            resolved.participants.length > 19 ||
            resolved.participants.some((p) => !CLEAN_LABEL.test(p.name)) ||
            new Set(resolved.participants.map((p) => p.personId)).size !==
              resolved.participants.length ||
            resolved.participants.some((p) => p.personId === identity.personId)
          )
            throw new MessagingError('CONTACT_RESOLUTION_INVALID');
          draft.participants = resolved.participants;
          draft.unresolvedNames = resolved.unresolvedNames;
        }
        response = await this.prepareReview(draft, identity);
        save = true;
      } else {
        response = `Send a receipt, or try “split $117 for dinner with Maya and Leo”. I’ll ask how to split it. Review any payment securely in Tallie: ${this.origin}\nReply STOP to pause messages.`;
      }
      if (save) await this.saveDraft(tx, current, draft, !!draftRow);
      await this.queue(tx, current, `reply:${row.id}`, response);
      await tx
        .updateTable('message_grants')
        .set({ last_message_at: occurrence })
        .where('id', '=', current.id)
        .execute();
      await tx
        .updateTable('message_inbox')
        .set({ state: 'done', lease_token: null, lease_until: null })
        .where('id', '=', row.id)
        .where('lease_token', '=', row.lease_token)
        .execute();
    });
    if (publication) {
      // The social adapter owns its transaction and locks/revalidates the grant.
      // Calling after reservation commits avoids locking the same grant across
      // two connections. A lost result reuses the permanent draft ID.
      const { draft, grant: authorizingGrant } = publication;
      const published = await this.hooks.publishEqualSplit!({
        identity,
        draftId: draft.id,
        version: draft.version,
        reviewDigest: draft.reviewDigest!,
        title: draft.title,
        totalMinor: draft.totalMinor!,
        participantIds: [identity.personId, ...draft.participants.map((p) => p.personId)],
      });
      await this.db.transaction().execute(async (tx) => {
        const reserved = await tx
          .selectFrom('message_drafts')
          .selectAll()
          .where('id', '=', draft.id)
          .where('publishing_message_id', '=', row.id)
          .forUpdate()
          .executeTakeFirst();
        if (!reserved) throw new MessagingError('PUBLICATION_RESERVATION_LOST', 409);
        draft.expenseId = published.expenseId;
        draft.stage = 'closed';
        await this.saveDraft(tx, authorizingGrant, draft, true);
        await this.queue(
          tx,
          authorizingGrant,
          `reply:${row.id}`,
          `Your split is ready. Each friend approves their own payment. ${this.origin}/?expense=${encodeURIComponent(published.expenseId)}`,
        );
        await tx
          .updateTable('message_grants')
          .set({ last_message_at: new Date(message.occurredAt) })
          .where('id', '=', grant.id)
          .execute();
        await tx
          .updateTable('message_inbox')
          .set({ state: 'done', lease_token: null, lease_until: null })
          .where('id', '=', row.id)
          .where('lease_token', '=', row.lease_token)
          .execute();
      });
    }
  }

  async processReadyReceipts(limit = 10): Promise<number> {
    if (!this.hooks.readReceipt) return 0;
    const rows = await this.db
      .selectFrom('message_drafts')
      .innerJoin('message_grants', 'message_grants.id', 'message_drafts.grant_id')
      .selectAll('message_drafts')
      .where('message_grants.provider_account', '=', this.options.providerAccount)
      .where('message_grants.revoked_at', 'is', null)
      .where('message_grants.expires_at', '>', this.now())
      .where('message_drafts.closed_at', 'is', null)
      .where('message_drafts.receipt_pending', '=', true)
      .where('message_drafts.next_receipt_check_at', '<=', this.now())
      .where('message_drafts.expires_at', '>', this.now())
      .orderBy('message_drafts.next_receipt_check_at', 'asc')
      .limit(Math.min(limit, 30))
      .execute();
    let updated = 0;
    for (const row of rows) {
      // Rotate every attempted poll, including failures, so one unavailable
      // receipt cannot monopolize the bounded batch or starve later drafts.
      await this.db
        .updateTable('message_drafts')
        .set({ next_receipt_check_at: new Date(this.now().getTime() + 15_000) })
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .execute();
      const previous = this.openDraft(row);
      if (!previous.receiptId || previous.receiptStatus !== 'processing') continue;
      const grant = await this.db
        .selectFrom('message_grants')
        .selectAll()
        .where('id', '=', row.grant_id)
        .executeTakeFirstOrThrow();
      if (!(await this.eligible(grant))) continue;
      const identity = this.identity(grant);
      const result = await this.hooks.readReceipt(identity, previous.receiptId).catch(() => null);
      if (!result) continue;
      if (result.status === 'queued' || result.status === 'processing') continue;
      await this.db.transaction().execute(async (tx) => {
        const lockedGrant = await tx
          .selectFrom('message_grants')
          .selectAll()
          .where('id', '=', grant.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const current = await tx
          .selectFrom('message_drafts')
          .selectAll()
          .where('id', '=', row.id)
          .where('closed_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (
          !current ||
          current.publishing_message_id ||
          current.web_publication_hash ||
          current.version !== row.version ||
          !(await this.eligible(lockedGrant))
        )
          return;
        const draft = this.openDraft(current);
        const validTotal =
          result.currency === 'USD' &&
          !!result.totalMinor &&
          /^(?:[1-9]\d{0,7})$/.test(result.totalMinor) &&
          BigInt(result.totalMinor) <= 10_000_000n;
        const safeTitle =
          result.title && CLEAN_LABEL.test(result.title) && !/[\d][\d\s-]{9,}|@/.test(result.title);
        const clearReceipt = Array.isArray(result.warnings) && result.warnings.length === 0;
        draft.receiptStatus =
          result.status === 'failed'
            ? 'failed'
            : validTotal && safeTitle && clearReceipt
              ? 'ready'
              : 'needs_review';
        if (draft.receiptStatus === 'ready') {
          draft.totalMinor = result.totalMinor!;
          draft.title = result.title!;
        }
        draft.version++;
        draft.reviewDigest = null;
        draft.reviewExpiresAt = null;
        const response = await this.prepareReview(draft, identity);
        await this.saveDraft(tx, grant, draft, true);
        await this.queue(tx, grant, `receipt:${draft.id}:${draft.receiptId}:ready`, response);
        updated++;
      });
    }
    return updated;
  }

  async dispatch(limit = 10): Promise<number> {
    if (!this.options.sendingEnabled) return 0;
    // A worker crash after submission is indistinguishable from acceptance.
    await this.db
      .updateTable('message_outbox')
      .set({ state: 'unknown', lease_token: null, lease_until: null })
      .where('provider_account', '=', this.options.providerAccount)
      .where('state', '=', 'sending')
      .where('lease_until', '<=', this.now())
      .execute();
    let processed = 0;
    for (let index = 0; index < Math.min(limit, 30); index++) {
      const attempt = await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom('message_outbox')
          .selectAll()
          .where('provider_account', '=', this.options.providerAccount)
          .where('state', '=', 'queued')
          .where('available_at', '<=', this.now())
          .orderBy('created_at', 'asc')
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (!row) return;
        const grant = await tx
          .selectFrom('message_grants')
          .selectAll()
          .where('id', '=', row.grant_id)
          .executeTakeFirstOrThrow();
        const preference = await tx
          .selectFrom('message_preferences')
          .select('stopped_at')
          .where('provider_account', '=', this.options.providerAccount)
          .where('phone_hash', '=', grant.phone_hash)
          .executeTakeFirst();
        const notificationAllowed =
          row.kind !== 'notification' ||
          (grant.notifications &&
            row.reference &&
            this.hooks.notificationEligible &&
            (await this.hooks.notificationEligible(grant.account_id, row.reference)));
        if (
          !row.payload_ciphertext ||
          row.expires_at <= this.now() ||
          !(await this.eligible(grant)) ||
          preference?.stopped_at ||
          !notificationAllowed
        ) {
          await tx
            .updateTable('message_outbox')
            .set({ state: 'suppressed' })
            .where('id', '=', row.id)
            .execute();
          return { suppressed: true as const };
        }
        const reserved = await tx
          .updateTable('message_outbox')
          .set({
            state: 'sending',
            attempts: row.attempts + 1,
            lease_token: randomUUID(),
            lease_until: new Date(this.now().getTime() + 60_000),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { suppressed: false as const, row: reserved, grant };
      });
      if (!attempt) break;
      processed++;
      if (attempt.suppressed) continue;
      const { row, grant } = attempt;
      // Recheck suppression immediately before crossing the provider boundary.
      const stopped = await this.db
        .selectFrom('message_preferences')
        .select('stopped_at')
        .where('provider_account', '=', this.options.providerAccount)
        .where('phone_hash', '=', grant.phone_hash)
        .executeTakeFirst();
      const latestGrant = await this.db
        .selectFrom('message_grants')
        .selectAll()
        .where('id', '=', grant.id)
        .executeTakeFirstOrThrow();
      if (stopped?.stopped_at || !(await this.eligible(latestGrant))) {
        await this.completeSend(row, 'suppressed');
        continue;
      }
      try {
        const sent = await this.transport.send({
          from: grant.sending_line,
          to: this.identity(grant).phone,
          content: this.vault.open(row.payload_ciphertext!, `outbox:${row.id}`),
          callbackUrl: `${this.origin}/api/webhooks/sendblue/status`,
        });
        await this.db
          .updateTable('message_outbox')
          .set({
            state: sent.status === 'delivered' ? 'delivered' : 'sent',
            provider_handle: sent.handle,
            lease_token: null,
            lease_until: null,
          })
          .where('id', '=', row.id)
          .where('lease_token', '=', row.lease_token)
          .execute();
        // A status callback may race the send response. Requeue unmatched statuses
        // for this exact handle after the durable binding becomes available.
        await this.db
          .updateTable('message_inbox')
          .set({ state: 'queued', available_at: this.now() })
          .where('provider_account', '=', this.options.providerAccount)
          .where('message_handle', '=', sent.handle)
          .where('kind', '=', 'status')
          .where('state', '=', 'held')
          .where('error_code', '=', 'UNMATCHED_DELIVERY_STATUS')
          .execute();
      } catch (error) {
        const outcome = error instanceof DeliveryError ? error.outcome : 'unknown';
        if (outcome === 'rate_limited' && row.attempts < 3)
          await this.db
            .updateTable('message_outbox')
            .set({
              state: 'queued',
              available_at: new Date(this.now().getTime() + 60_000 * row.attempts),
              lease_token: null,
              lease_until: null,
            })
            .where('id', '=', row.id)
            .where('lease_token', '=', row.lease_token)
            .execute();
        else await this.completeSend(row, outcome === 'unknown' ? 'unknown' : 'failed');
      }
    }
    return processed;
  }

  private async completeSend(row: Outbox, state: 'suppressed' | 'unknown' | 'failed') {
    await this.db
      .updateTable('message_outbox')
      .set({ state, lease_token: null, lease_until: null })
      .where('id', '=', row.id)
      .where('lease_token', '=', row.lease_token)
      .execute();
  }

  async purgeExpired(): Promise<void> {
    await this.db
      .updateTable('message_inbox')
      .set({ payload_ciphertext: null, state: 'ignored', lease_token: null, lease_until: null })
      .where('provider_account', '=', this.options.providerAccount)
      .where('expires_at', '<=', this.now())
      .where('payload_ciphertext', 'is not', null)
      .execute();
    await this.db
      .updateTable('message_outbox')
      .set({ state: 'suppressed' })
      .where('provider_account', '=', this.options.providerAccount)
      .where('expires_at', '<=', this.now())
      .where('state', '=', 'queued')
      .execute();
    await this.db
      .updateTable('message_outbox')
      .set({ payload_ciphertext: null })
      .where('provider_account', '=', this.options.providerAccount)
      .where('expires_at', '<=', this.now())
      .where('payload_ciphertext', 'is not', null)
      .execute();
    await this.db
      .updateTable('message_grants')
      .set({ phone_ciphertext: null })
      .where('provider_account', '=', this.options.providerAccount)
      .where((eb) => eb.or([eb('expires_at', '<=', this.now()), eb('revoked_at', 'is not', null)]))
      .where('phone_ciphertext', 'is not', null)
      .execute();
    await this.db
      .deleteFrom('message_outbox')
      .where('provider_account', '=', this.options.providerAccount)
      .where('expires_at', '<', new Date(this.now().getTime() - 30 * DAY))
      .where('state', 'not in', ['sending', 'unknown'])
      .execute();
    await this.db.deleteFrom('message_drafts').where('expires_at', '<=', this.now()).execute();
  }
}

export function providerAccountFingerprint(keyId: string): string {
  return createHash('sha256').update(`sendblue-account:${keyId}`).digest('hex');
}
