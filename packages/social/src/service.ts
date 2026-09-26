import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PhoneVault } from '@tallie/channels';
import { allocateByItem, allocateCustom, allocateEqual, type Allocation } from '@tallie/domain';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  CreateSocialExpense,
  InvitationClaim,
  InvitationInspection,
  SocialContact,
  SocialDashboard,
  SocialExpense,
  SocialInvitation,
} from './contracts';
import type { SocialDatabase } from './schema';
import {
  canonicalJson,
  contactInput,
  expenseInput,
  invitationInput,
  SocialError,
  tokenInput,
} from './validation';

export interface SocialPrincipal {
  userId: string;
  sessionId: string;
  phoneHash: string;
  displayName: string;
}
type ContactRow = Selectable<SocialDatabase['social_contacts']>;
type InvitationRow = Selectable<SocialDatabase['social_invitations']>;
type Db = Kysely<SocialDatabase>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const notFound = () =>
  new SocialError('NOT_FOUND', 'That item is not available to this account.', 404);
const contactDto = (row: ContactRow): SocialContact => ({
  id: row.id,
  label: row.label,
  maskedPhone: row.masked_phone,
  status: row.connected_user_id ? 'connected' : 'invitation_needed',
  createdAt: row.created_at.toISOString(),
});

/** Real collaboration commands. No dependency on a payment adapter or simulator. */
export class SocialService {
  constructor(
    private readonly db: Db,
    private readonly vault: PhoneVault,
    private readonly origin: string,
    private readonly clock = () => new Date(),
    private readonly receiptUploadEnabled = false,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('An HTTPS application origin is required.');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Invalid application origin.');
  }

  private async lockAccount(tx: Db, actor: SocialPrincipal): Promise<void> {
    const found = await sql<{ id: string }>`
      SELECT s.id FROM auth_session s JOIN auth_user u ON u.id=s.user_id
      JOIN identity_phone_bindings p ON p.user_id=u.id
      WHERE s.id=${actor.sessionId}::uuid AND s.user_id=${actor.userId}::uuid
      AND s.expires_at>${this.clock()} AND s.assurance_kind IN ('passkey','recovery')
      AND p.phone_hash=${actor.phoneHash}
      FOR SHARE OF s, u, p
    `.execute(tx);
    if (!found.rows.length)
      throw new SocialError('AUTH_REQUIRED', 'Sign in again to continue.', 401);
  }

  private async command<T>(
    actor: SocialPrincipal,
    scope: string,
    key: string,
    body: unknown,
    create: (tx: Transaction<SocialDatabase>) => Promise<string>,
    read: (tx: Db, id: string) => Promise<T>,
    authorize?: (tx: Db) => Promise<void>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new SocialError('IDEMPOTENCY_KEY_REQUIRED', 'This action needs a unique retry key.');
    return this.db.transaction().execute(async (tx) => {
      if (authorize) await authorize(tx);
      else await this.lockAccount(tx, actor);
      // Serializes mutations for this user, including quotas and same-phone insert races.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`social:${actor.userId}`}, 0))`.execute(
        tx,
      );
      const digest = hash(canonicalJson(body));
      const previous = await tx
        .selectFrom('social_idempotency')
        .selectAll()
        .where('user_id', '=', actor.userId)
        .where('scope', '=', scope)
        .where('key', '=', key)
        .executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== digest)
          throw new SocialError(
            'IDEMPOTENCY_CONFLICT',
            'This retry belongs to different details.',
            409,
          );
        return read(tx, previous.resource_id);
      }
      const id = await create(tx);
      await tx
        .insertInto('social_idempotency')
        .values({ user_id: actor.userId, scope, key, request_hash: digest, resource_id: id })
        .execute();
      return read(tx, id);
    });
  }

  async addContact(
    actor: SocialPrincipal,
    input: { label: string; phone: string },
    key: string,
  ): Promise<SocialContact> {
    const parsed = contactInput.parse(input);
    const phoneHash = this.vault.lookup(parsed.phone);
    if (phoneHash === actor.phoneHash)
      throw new SocialError(
        'SELF_CONTACT',
        'Your own share is already included. Add a friend’s number.',
      );
    return this.command(
      actor,
      'contact',
      key,
      { label: parsed.label, phoneHash },
      async (tx) => {
        const previous = await tx
          .selectFrom('social_contacts')
          .selectAll()
          .where('owner_user_id', '=', actor.userId)
          .where('phone_hash', '=', phoneHash)
          .executeTakeFirst();
        if (previous) return previous.id;
        const count = await tx
          .selectFrom('social_contacts')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('owner_user_id', '=', actor.userId)
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 200)
          throw new SocialError(
            'CONTACT_LIMIT',
            'You have reached the private beta contact limit.',
            429,
          );
        const id = randomUUID();
        await tx
          .insertInto('social_contacts')
          .values({
            id,
            owner_user_id: actor.userId,
            label: parsed.label,
            phone_hash: phoneHash,
            phone_ciphertext: this.vault.seal(parsed.phone, `social-contact:${id}`),
            masked_phone: `••• ••• ${parsed.phone.slice(-4)}`,
            connected_user_id: null,
          })
          .execute();
        return id;
      },
      async (tx, id) => {
        const row = await tx
          .selectFrom('social_contacts')
          .selectAll()
          .where('id', '=', id)
          .where('owner_user_id', '=', actor.userId)
          .executeTakeFirst();
        if (!row) throw notFound();
        return contactDto(row);
      },
    );
  }

  /** Exact, unique aliases only. Unknown and ambiguous names have the same safe outcome. */
  async resolveContacts(
    userId: string,
    names: string[],
  ): Promise<{ participants: { personId: string; name: string }[]; unresolvedNames: string[] }> {
    const contacts = await this.db
      .selectFrom('social_contacts')
      .select(['id', 'label'])
      .where('owner_user_id', '=', userId)
      .execute();
    const normalize = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
    const participants: { personId: string; name: string }[] = [];
    const unresolvedNames: string[] = [];
    for (const name of names.slice(0, 20)) {
      const matches = contacts.filter((contact) => normalize(contact.label) === normalize(name));
      if (matches.length !== 1) unresolvedNames.push(name);
      else if (!participants.some((person) => person.personId === matches[0]!.id))
        participants.push({ personId: matches[0]!.id, name: matches[0]!.label });
    }
    return { participants, unresolvedNames };
  }

  async createExpense(
    actor: SocialPrincipal,
    input: CreateSocialExpense,
    key: string,
  ): Promise<SocialExpense> {
    return this.publishExpense(actor, input, key);
  }

  /** Trusted worker boundary only. The caller must lock and validate its channel grant in tx. */
  async createExpenseFromChannel(
    actor: Omit<SocialPrincipal, 'sessionId'>,
    input: CreateSocialExpense,
    key: string,
    authorize: (tx: Db) => Promise<void>,
  ): Promise<SocialExpense> {
    return this.publishExpense({ ...actor, sessionId: '' }, input, key, authorize);
  }

  private async publishExpense(
    actor: SocialPrincipal,
    input: CreateSocialExpense,
    key: string,
    authorize?: (tx: Db) => Promise<void>,
  ): Promise<SocialExpense> {
    const parsed = expenseInput.parse(input);
    const ids = parsed.participantIds;
    if (!ids.includes(actor.userId) || new Set(ids).size !== ids.length)
      throw new SocialError(
        'INVALID_PARTICIPANTS',
        'Include yourself and choose each friend once.',
      );
    let allocations: readonly Allocation[];
    let subtotal = BigInt(parsed.totalMinor);
    if (parsed.method === 'equal') allocations = allocateEqual(BigInt(parsed.totalMinor), ids);
    else if (parsed.method === 'custom') {
      if (
        !parsed.shares ||
        parsed.shares.length !== ids.length ||
        parsed.shares.some((share) => !ids.includes(share.participantId))
      )
        throw new SocialError('INVALID_SHARES', 'Set one share for every participant.');
      allocations = allocateCustom(
        BigInt(parsed.totalMinor),
        parsed.shares.map((share) => ({
          participantId: share.participantId,
          amountMinor: BigInt(share.amountMinor),
        })),
      );
    } else {
      if (!parsed.items?.length || parsed.taxMinor === undefined || parsed.tipMinor === undefined)
        throw new SocialError('INCOMPLETE_RECEIPT', 'Confirm the receipt items, tax, and tip.');
      const result = allocateByItem({
        participantIds: ids,
        items: parsed.items.map((item) => ({
          id: item.id,
          totalMinor: BigInt(item.amountMinor),
          participantIds: item.participantIds,
        })),
        taxMinor: BigInt(parsed.taxMinor),
        tipMinor: BigInt(parsed.tipMinor),
        discountMinor: BigInt(parsed.discountMinor ?? '0'),
        statedTotalMinor: BigInt(parsed.totalMinor),
      });
      allocations = result.allocations;
      subtotal = result.subtotalMinor;
    }
    return this.command(
      actor,
      'expense',
      key,
      parsed,
      async (tx) => {
        const recent = await tx
          .selectFrom('social_expenses')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('owner_user_id', '=', actor.userId)
          .where('created_at', '>', new Date(this.clock().getTime() - 86_400_000))
          .executeTakeFirstOrThrow();
        if (Number(recent.count) >= 50)
          throw new SocialError(
            'EXPENSE_LIMIT',
            'You have reached today’s private beta split limit.',
            429,
          );
        const contacts = await tx
          .selectFrom('social_contacts')
          .selectAll()
          .where('owner_user_id', '=', actor.userId)
          .where(
            'id',
            'in',
            ids.filter((id) => id !== actor.userId),
          )
          .orderBy('id')
          .forUpdate()
          .execute();
        if (contacts.length !== ids.length - 1)
          throw new SocialError('INVALID_PARTICIPANTS', 'Choose people from your own contacts.');
        const id = randomUUID();
        await tx
          .insertInto('social_expenses')
          .values({
            id,
            owner_user_id: actor.userId,
            payer_name: actor.displayName,
            title: parsed.title,
            emoji: parsed.emoji,
            category: parsed.category,
            total_minor: parsed.totalMinor,
            currency: 'USD',
            method: parsed.method,
            items: JSON.stringify(parsed.method === 'items' ? parsed.items : []),
            subtotal_minor: subtotal.toString(),
            tax_minor: parsed.method === 'items' ? parsed.taxMinor! : '0',
            tip_minor: parsed.method === 'items' ? parsed.tipMinor! : '0',
            discount_minor: parsed.method === 'items' ? (parsed.discountMinor ?? '0') : '0',
          })
          .execute();
        for (const allocation of allocations) {
          const own = allocation.participantId === actor.userId;
          const contact = contacts.find((row) => row.id === allocation.participantId);
          let displayName: string | null = own ? actor.displayName : null;
          if (contact?.connected_user_id) {
            const user = await sql<{
              name: string;
            }>`SELECT name FROM auth_user WHERE id=${contact.connected_user_id}::uuid`.execute(tx);
            displayName = user.rows[0]?.name ?? null;
          }
          await tx
            .insertInto('social_shares')
            .values({
              id: randomUUID(),
              expense_id: id,
              participant_id: allocation.participantId,
              contact_id: contact?.id ?? null,
              user_id: own ? actor.userId : (contact?.connected_user_id ?? null),
              phone_hash: own ? actor.phoneHash : contact!.phone_hash,
              private_label: own ? actor.displayName : contact!.label,
              display_name: displayName,
              amount_minor: allocation.amountMinor.toString(),
              is_payer: own,
              canceled_at: null,
            })
            .execute();
        }
        return id;
      },
      (tx, id) => this.expense(actor.userId, id, tx),
      authorize,
    );
  }

  async expense(userId: string, id: string, db: Db = this.db): Promise<SocialExpense> {
    const expense = await db
      .selectFrom('social_expenses')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!expense) throw notFound();
    const shares = await db
      .selectFrom('social_shares')
      .selectAll()
      .where('expense_id', '=', id)
      .orderBy('participant_id')
      .execute();
    if (expense.owner_user_id !== userId && !shares.some((share) => share.user_id === userId))
      throw notFound();
    const isOwner = expense.owner_user_id === userId;
    return {
      id,
      title: expense.title,
      emoji: expense.emoji,
      category: expense.category,
      totalMinor: expense.total_minor,
      currency: 'USD',
      method: expense.method,
      paidByName: expense.payer_name,
      isOwner,
      items: expense.items,
      subtotalMinor: expense.subtotal_minor,
      taxMinor: expense.tax_minor,
      tipMinor: expense.tip_minor,
      discountMinor: expense.discount_minor,
      createdAt: expense.created_at.toISOString(),
      paymentsEnabled: false,
      shares: shares.map((share) => ({
        id: share.id,
        participantId: share.participant_id,
        name: isOwner ? share.private_label : (share.display_name ?? 'Invited friend'),
        amountMinor: share.amount_minor,
        isYou: share.user_id === userId,
        status: share.is_payer
          ? 'self'
          : share.amount_minor === '0'
            ? 'no_payment'
            : share.canceled_at
              ? 'canceled'
              : share.user_id
                ? 'payment_setup_pending'
                : 'invite_ready',
      })),
    };
  }

  async dashboard(actor: SocialPrincipal): Promise<SocialDashboard> {
    const contacts = await this.db
      .selectFrom('social_contacts')
      .selectAll()
      .where('owner_user_id', '=', actor.userId)
      .orderBy('created_at', 'desc')
      .execute();
    const rows = await this.db
      .selectFrom('social_expenses')
      .innerJoin('social_shares', 'social_shares.expense_id', 'social_expenses.id')
      .select(['social_expenses.id', 'social_expenses.created_at'])
      .where((eb) =>
        eb.or([
          eb('social_expenses.owner_user_id', '=', actor.userId),
          eb('social_shares.user_id', '=', actor.userId),
        ]),
      )
      .distinct()
      .orderBy('social_expenses.created_at', 'desc')
      .limit(100)
      .execute();
    const totals = await sql<{ owed: string; owing: string }>`
      SELECT COALESCE(SUM(CASE WHEN e.owner_user_id=${actor.userId}::uuid THEN s.amount_minor ELSE 0 END),0)::text AS owed,
      COALESCE(SUM(CASE WHEN s.user_id=${actor.userId}::uuid THEN s.amount_minor ELSE 0 END),0)::text AS owing
      FROM social_shares s JOIN social_expenses e ON e.id=s.expense_id
      WHERE NOT s.is_payer AND s.canceled_at IS NULL AND (e.owner_user_id=${actor.userId}::uuid OR s.user_id=${actor.userId}::uuid)
    `.execute(this.db);
    return {
      userId: actor.userId,
      displayName: actor.displayName,
      capabilities: { receiptUpload: this.receiptUploadEnabled },
      contacts: contacts.map(contactDto),
      expenses: await Promise.all(rows.map((row) => this.expense(actor.userId, row.id))),
      summary: {
        owedToYouMinor: totals.rows[0]?.owed ?? '0',
        owingMinor: totals.rows[0]?.owing ?? '0',
      },
      paymentsEnabled: false,
    };
  }

  async createInvitation(
    actor: SocialPrincipal,
    input: { contactId: string; expenseId?: string | undefined },
    key: string,
  ): Promise<SocialInvitation> {
    const parsed = invitationInput.parse(input);
    return this.command(
      actor,
      'invitation',
      key,
      parsed,
      async (tx) => {
        const contact = await tx
          .selectFrom('social_contacts')
          .selectAll()
          .where('id', '=', parsed.contactId)
          .where('owner_user_id', '=', actor.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!contact) throw notFound();
        if (parsed.expenseId) {
          const expense = await tx
            .selectFrom('social_expenses')
            .select('id')
            .where('id', '=', parsed.expenseId)
            .where('owner_user_id', '=', actor.userId)
            .executeTakeFirst();
          const share = await tx
            .selectFrom('social_shares')
            .select('id')
            .where('expense_id', '=', parsed.expenseId)
            .where('contact_id', '=', contact.id)
            .where('canceled_at', 'is', null)
            .executeTakeFirst();
          if (!expense || !share) throw notFound();
        }
        const count = await tx
          .selectFrom('social_invitations')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('owner_user_id', '=', actor.userId)
          .where('created_at', '>', new Date(this.clock().getTime() - 86_400_000))
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 100)
          throw new SocialError(
            'INVITATION_LIMIT',
            'You have reached today’s invitation limit.',
            429,
          );
        const id = randomUUID();
        const token = randomBytes(32).toString('base64url');
        await tx
          .insertInto('social_invitations')
          .values({
            id,
            owner_user_id: actor.userId,
            contact_id: contact.id,
            expense_id: parsed.expenseId ?? null,
            phone_hash: contact.phone_hash,
            token_hash: hash(token),
            token_ciphertext: this.vault.seal(token, `social-invite:${id}`),
            expires_at: new Date(this.clock().getTime() + 7 * 86_400_000),
            claimed_by_user_id: null,
            claimed_at: null,
            revoked_at: null,
          })
          .execute();
        return id;
      },
      async (tx, id) => {
        const row = await tx
          .selectFrom('social_invitations')
          .selectAll()
          .where('id', '=', id)
          .where('owner_user_id', '=', actor.userId)
          .executeTakeFirst();
        if (!row) throw notFound();
        return this.invitationDto(row);
      },
    );
  }

  private invitationDto(row: InvitationRow): SocialInvitation {
    const token = this.vault.open(row.token_ciphertext, `social-invite:${row.id}`);
    return {
      id: row.id,
      contactId: row.contact_id,
      expenseId: row.expense_id,
      url: `${new URL(this.origin).origin}/invite#token=${token}`,
      expiresAt: row.expires_at.toISOString(),
      status: row.revoked_at
        ? 'revoked'
        : row.claimed_at
          ? 'claimed'
          : row.expires_at <= this.clock()
            ? 'expired'
            : 'pending',
    };
  }

  async inspectInvitation(token: string): Promise<InvitationInspection> {
    if (!tokenInput.safeParse({ token }).success)
      return { status: 'unavailable', purpose: 'join_tallie' };
    const row = await this.db
      .selectFrom('social_invitations')
      .select('id')
      .where('token_hash', '=', hash(token))
      .where('revoked_at', 'is', null)
      .where('claimed_at', 'is', null)
      .where('expires_at', '>', this.clock())
      .executeTakeFirst();
    return { status: row ? 'available' : 'unavailable', purpose: 'join_tallie' };
  }

  async claimInvitation(actor: SocialPrincipal, token: string): Promise<InvitationClaim> {
    tokenInput.parse({ token });
    return this.db.transaction().execute(async (tx) => {
      await this.lockAccount(tx, actor);
      const hint = await tx
        .selectFrom('social_invitations')
        .select('owner_user_id')
        .where('token_hash', '=', hash(token))
        .executeTakeFirst();
      if (!hint) throw notFound();
      // Both directions of a friendship acquire the same pair lock before contact locks.
      const pair = [actor.userId, hint.owner_user_id].sort().join(':');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`social-pair:${pair}`},0))`.execute(
        tx,
      );
      // Invite before contact is the consistent claim/revocation lock order.
      const invitation = await tx
        .selectFrom('social_invitations')
        .selectAll()
        .where('token_hash', '=', hash(token))
        .forUpdate()
        .executeTakeFirst();
      if (
        !invitation ||
        invitation.phone_hash !== actor.phoneHash ||
        invitation.revoked_at ||
        invitation.owner_user_id === actor.userId
      )
        throw new SocialError(
          'INVITATION_UNAVAILABLE',
          'This invitation is not available to this account. Sign in with the number your friend invited.',
          404,
        );
      if (invitation.claimed_at) {
        if (invitation.claimed_by_user_id !== actor.userId) throw notFound();
        return {
          contactId: invitation.contact_id,
          expenseId: invitation.expense_id,
          connected: true,
        };
      }
      if (invitation.expires_at <= this.clock())
        throw new SocialError(
          'INVITATION_EXPIRED',
          'This invitation expired. Ask your friend for a new link.',
          410,
        );
      const contact = await tx
        .selectFrom('social_contacts')
        .selectAll()
        .where('id', '=', invitation.contact_id)
        .where('owner_user_id', '=', invitation.owner_user_id)
        .where('phone_hash', '=', actor.phoneHash)
        .forUpdate()
        .executeTakeFirst();
      if (!contact || (contact.connected_user_id && contact.connected_user_id !== actor.userId))
        throw notFound();
      if (invitation.expense_id) {
        const updated = await tx
          .updateTable('social_shares')
          .set({ user_id: actor.userId, display_name: actor.displayName })
          .where('expense_id', '=', invitation.expense_id)
          .where('contact_id', '=', contact.id)
          .where('phone_hash', '=', actor.phoneHash)
          .where('canceled_at', 'is', null)
          .where((eb) => eb.or([eb('user_id', 'is', null), eb('user_id', '=', actor.userId)]))
          .returning('id')
          .executeTakeFirst();
        if (!updated)
          throw new SocialError(
            'INVITATION_UNAVAILABLE',
            'This share is no longer available.',
            409,
          );
      }
      await tx
        .updateTable('social_contacts')
        .set({ connected_user_id: actor.userId })
        .where('id', '=', contact.id)
        .execute();
      const sender = await sql<{
        name: string;
        phone_hash: string;
        masked_phone: string;
      }>`SELECT u.name,p.phone_hash,p.masked_phone FROM auth_user u JOIN identity_phone_bindings p ON p.user_id=u.id WHERE u.id=${invitation.owner_user_id}::uuid`.execute(
        tx,
      );
      const friend = sender.rows[0];
      if (!friend) throw notFound();
      // Acceptance creates the reverse relationship without copying the sender's raw phone.
      const reverse = await tx
        .insertInto('social_contacts')
        .values({
          id: randomUUID(),
          owner_user_id: actor.userId,
          label: friend.name,
          phone_hash: friend.phone_hash,
          phone_ciphertext: null,
          masked_phone: friend.masked_phone,
          connected_user_id: invitation.owner_user_id,
        })
        .onConflict((oc) =>
          oc
            .columns(['owner_user_id', 'phone_hash'])
            .doUpdateSet({ connected_user_id: invitation.owner_user_id })
            .where((eb) =>
              eb.or([
                eb('social_contacts.connected_user_id', 'is', null),
                eb('social_contacts.connected_user_id', '=', invitation.owner_user_id),
              ]),
            ),
        )
        .returning('id')
        .executeTakeFirst();
      if (!reverse)
        throw new SocialError(
          'CONTACT_CHANGED',
          'This contact needs to be reviewed before connecting.',
          409,
        );
      await tx
        .updateTable('social_invitations')
        .set({ claimed_by_user_id: actor.userId, claimed_at: this.clock() })
        .where('id', '=', invitation.id)
        .execute();
      await tx
        .insertInto('social_invitation_claims')
        .values({
          invitation_id: invitation.id,
          user_id: actor.userId,
          session_id: actor.sessionId,
          phone_hash: actor.phoneHash,
        })
        .execute();
      return { contactId: contact.id, expenseId: invitation.expense_id, connected: true };
    });
  }

  async revokeInvitation(actor: SocialPrincipal, id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.lockAccount(tx, actor);
      const invitation = await tx
        .selectFrom('social_invitations')
        .selectAll()
        .where('id', '=', id)
        .where('owner_user_id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!invitation) throw notFound();
      if (invitation.claimed_at)
        throw new SocialError('ALREADY_CLAIMED', 'This invitation has already been accepted.', 409);
      await tx
        .updateTable('social_invitations')
        .set({ revoked_at: this.clock() })
        .where('id', '=', id)
        .execute();
    });
  }

  async cancelShare(
    actor: SocialPrincipal,
    expenseId: string,
    shareId: string,
  ): Promise<SocialExpense> {
    return this.db.transaction().execute(async (tx) => {
      await this.lockAccount(tx, actor);
      const expense = await tx
        .selectFrom('social_expenses')
        .select('id')
        .where('id', '=', expenseId)
        .where('owner_user_id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!expense) throw notFound();
      const share = await tx
        .updateTable('social_shares')
        .set({ canceled_at: sql`COALESCE(canceled_at, ${this.clock()})` })
        .where('id', '=', shareId)
        .where('expense_id', '=', expenseId)
        .where('is_payer', '=', false)
        .returning('id')
        .executeTakeFirst();
      if (!share) throw notFound();
      return this.expense(actor.userId, expenseId, tx);
    });
  }
}
