import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccountPrincipal } from '@tallie/identity';
import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';
import type { ProductionConnectionState } from './contracts';
export type { ProductionConnectionState } from './contracts';

const LEASE_MS = 90_000;
const RECENT_PASSKEY_MS = 10 * 60_000;
const RECHECK_INTERVAL_MS = 15_000;
const providerId = (prefix: string, value: string) =>
  new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ProductionConnectionVault {
  open(value: string, context: string): string;
  seal(value: string, context: string): string;
  lookup(value: string): string;
}
/** Binding/schema failures block activation until an explicit canonical recheck succeeds. */
export interface ProductionConnectionGateway {
  createInvitation(input: {
    verifiedPhone: string;
    returnState: string;
    perTransactionLimitMinor: number;
    operation: { instanceId: string; idempotencyKey: string };
  }): Promise<{ invitationId: string; url: string; expiresAt: string }>;
  verifyAcceptedConnection(input: {
    eventId: string;
    invitationId: string;
    perTransactionLimitMinor: number;
  }): Promise<{
    customerPartyId: string;
    delegationId: string;
    agentId: string;
    perTransactionLimitMinor: number;
    invitationAccepted: true;
    moneyMovementEnabled: false;
  }>;
  getReceivingWallet(customerPartyId: string): Promise<{
    id: string;
    partyId: string;
    status: string;
    walletType: string;
    agentDefault: boolean | undefined;
    currency: 'USD' | null;
  }>;
}
export interface ProductionConnectionConfiguration {
  enabled: boolean;
  environment: 'production';
  platformPartyId: string;
  agentId: string;
  perTransactionLimitMinor: number;
}

type Row = {
  id: string;
  account_id: string;
  phone_hash: string;
  platform_party_id: string;
  agent_id: string;
  per_transaction_limit_minor: number;
  status: Exclude<NonNullable<ProductionConnectionState['connection']>['status'], 'expired'>;
  invite_operation_id: string;
  invite_idempotency_key: string;
  return_state_hash: string;
  invitation_id: string | null;
  invitation_url_ciphertext: string | null;
  invitation_expires_at: Date | null;
  accepted_event_id: string | null;
  lease_token: string | null;
  lease_until: Date | null;
  generation: number;
};

export class ProductionConnectionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'ProductionConnectionError';
  }
}

/** Hosted activation only. There are deliberately no payment or funding commands. */
export class ProductionConnectionService {
  private readonly config: Readonly<ProductionConnectionConfiguration>;
  constructor(
    private readonly db: Kysely<PaymentDatabase>,
    private readonly gateway: ProductionConnectionGateway,
    private readonly vault: ProductionConnectionVault | null,
    config: ProductionConnectionConfiguration,
    private readonly clock = () => new Date(),
  ) {
    if (
      config.environment !== 'production' ||
      !providerId('pty', config.platformPartyId) ||
      !providerId('agt', config.agentId) ||
      !Number.isInteger(config.perTransactionLimitMinor) ||
      config.perTransactionLimitMinor < 1 ||
      config.perTransactionLimitMinor > 10_000
    )
      throw new Error('Production activation configuration is invalid.');
    this.config = Object.freeze({ ...config });
  }

  private async authorize(tx: Kysely<PaymentDatabase>, actor: AccountPrincipal, recent = false) {
    const now = this.clock();
    const result = await sql<{ phone_ciphertext: string }>`
      SELECT p.phone_ciphertext FROM auth_session s
      JOIN auth_user u ON u.id=s.user_id
      JOIN identity_phone_bindings p ON p.user_id=u.id
      WHERE s.id=${actor.sessionId}::uuid AND s.user_id=${actor.userId}::uuid
        AND s.expires_at>${now} AND s.assurance_kind='passkey'
        AND s.assurance_at<=${now} AND p.phone_hash=${actor.phoneHash}
        AND EXISTS(SELECT 1 FROM auth_passkey k WHERE k.user_id=u.id)
        AND (NOT ${recent} OR s.assurance_at>=${new Date(now.getTime() - RECENT_PASSKEY_MS)})
      FOR SHARE OF s,u,p
    `.execute(tx);
    if (!result.rows[0]) throw new ProductionConnectionError('RECENT_PASSKEY_REQUIRED', 401);
    return result.rows[0];
  }

  private compatible(row: Row, phoneHash?: string) {
    if (
      row.platform_party_id !== this.config.platformPartyId ||
      row.agent_id !== this.config.agentId ||
      row.per_transaction_limit_minor !== this.config.perTransactionLimitMinor ||
      (phoneHash !== undefined && row.phone_hash !== phoneHash)
    )
      throw new ProductionConnectionError('CONNECTION_BINDING_CHANGED');
  }

  private invitationUrl(value: string, invitationId: string): string {
    const url = new URL(value);
    if (
      !providerId('adi', invitationId) ||
      url.origin !== 'https://www.natural.com' ||
      url.pathname !== `/connect/${invitationId}` ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ProductionConnectionError('INVITATION_BINDING_MISMATCH');
    return url.toString();
  }

  async state(actor: AccountPrincipal): Promise<ProductionConnectionState> {
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const row = (
        await sql<Row>`SELECT * FROM natural_production_connections
        WHERE account_id=${actor.userId}::uuid`.execute(tx)
      ).rows[0];
      if (row) this.compatible(row, actor.phoneHash);
      let connection: ProductionConnectionState['connection'] = null;
      if (row) {
        const stale = row.lease_until === null || row.lease_until <= this.clock();
        const expired =
          row.invitation_expires_at !== null && row.invitation_expires_at <= this.clock();
        const status =
          ['inviting', 'verifying'].includes(row.status) && stale
            ? 'unknown'
            : row.status === 'pending' && expired
              ? 'expired'
              : row.status;
        const url =
          this.config.enabled && status === 'pending' && this.vault && row.invitation_url_ciphertext
            ? this.invitationUrl(
                this.vault.open(
                  row.invitation_url_ciphertext,
                  `natural-production:${row.id}:invitation`,
                ),
                row.invitation_id!,
              )
            : null;
        connection = {
          status,
          invitationUrl: url,
          invitationExpiresAt: row.invitation_expires_at?.toISOString() ?? null,
        };
      }
      return {
        available: this.config.enabled,
        environment: 'production',
        moneyMovementEnabled: false,
        connection,
      };
    });
  }

  /** One durable attempt. Natural's production invitation endpoint does not promise idempotent replay. */
  async start(actor: AccountPrincipal): Promise<ProductionConnectionState> {
    if (!this.config.enabled || !this.vault)
      throw new ProductionConnectionError('CONNECTION_UNAVAILABLE', 503);
    const vault = this.vault;
    const prepared = await this.db.transaction().execute(async (tx) => {
      const binding = await this.authorize(tx, actor, true);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`natural-production:${actor.userId}`},0))`.execute(
        tx,
      );
      const existing = (
        await sql<Row>`SELECT * FROM natural_production_connections
        WHERE account_id=${actor.userId}::uuid FOR UPDATE`.execute(tx)
      ).rows[0];
      if (existing) {
        this.compatible(existing, actor.phoneHash);
        return null;
      }
      const phone = vault.open(binding.phone_ciphertext, `${actor.userId}:phone`);
      if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone) || vault.lookup(phone) !== actor.phoneHash)
        throw new ProductionConnectionError('PHONE_BINDING_CHANGED');
      const returnState = randomBytes(32).toString('base64url');
      const now = this.clock();
      const row = (
        await sql<Row>`INSERT INTO natural_production_connections
        (id,account_id,phone_hash,platform_party_id,agent_id,per_transaction_limit_minor,status,
         invite_operation_id,invite_idempotency_key,return_state_hash,lease_token,lease_until,generation,
         first_submission_at,created_at,updated_at)
        VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,${actor.phoneHash},${this.config.platformPartyId},
          ${this.config.agentId},${this.config.perTransactionLimitMinor},'inviting',${randomUUID()}::uuid,
          ${randomUUID()}::uuid,${digest(returnState)},${randomUUID()}::uuid,${new Date(now.getTime() + LEASE_MS)},1,${now},${now},${now})
        RETURNING *`.execute(tx)
      ).rows[0]!;
      return { row, phone, returnState };
    });
    if (prepared) {
      try {
        const invite = await this.gateway.createInvitation({
          verifiedPhone: prepared.phone,
          returnState: prepared.returnState,
          perTransactionLimitMinor: this.config.perTransactionLimitMinor,
          operation: {
            instanceId: prepared.row.invite_operation_id,
            idempotencyKey: prepared.row.invite_idempotency_key,
          },
        });
        const url = this.invitationUrl(invite.url, invite.invitationId);
        const expires = new Date(invite.expiresAt);
        if (!Number.isFinite(expires.getTime()) || expires <= this.clock())
          throw new ProductionConnectionError('INVITATION_EXPIRED');
        await sql`UPDATE natural_production_connections SET
          invitation_id=${invite.invitationId},invitation_url_ciphertext=${vault.seal(url, `natural-production:${prepared.row.id}:invitation`)},
          invitation_expires_at=${expires},status='pending',lease_token=NULL,lease_until=NULL,updated_at=${this.clock()}
          WHERE id=${prepared.row.id}::uuid AND status='inviting' AND generation=${prepared.row.generation}
            AND lease_token=${prepared.row.lease_token}::uuid AND lease_until>${this.clock()}`.execute(
          this.db,
        );
      } catch {
        await sql`UPDATE natural_production_connections SET status='unknown',lease_token=NULL,lease_until=NULL,updated_at=${this.clock()}
          WHERE id=${prepared.row.id}::uuid AND status='inviting' AND generation=${prepared.row.generation}
            AND lease_token=${prepared.row.lease_token}::uuid`.execute(this.db);
      }
    }
    return this.state(actor);
  }

  /** The callback can validate navigation state only. It cannot accept or connect anything. */
  async matchReturn(actor: AccountPrincipal, state: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(state)) return false;
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const row = (
        await sql<Row>`SELECT * FROM natural_production_connections
        WHERE account_id=${actor.userId}::uuid AND return_state_hash=${digest(state)}`.execute(tx)
      ).rows[0];
      if (!row) return false;
      this.compatible(row, actor.phoneHash);
      return true;
    });
  }

  /** Recheck only this account's saved acceptance; never create/replay an invitation. */
  async refresh(actor: AccountPrincipal): Promise<ProductionConnectionState> {
    if (!this.config.enabled) throw new ProductionConnectionError('CONNECTION_UNAVAILABLE', 503);
    const hint = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      const row = (
        await sql<Row>`SELECT * FROM natural_production_connections
        WHERE account_id=${actor.userId}::uuid`.execute(tx)
      ).rows[0];
      if (!row) return null;
      this.compatible(row, actor.phoneHash);
      return row.invitation_id && row.accepted_event_id
        ? { invitationId: row.invitation_id, eventId: row.accepted_event_id }
        : null;
    });
    if (hint) await this.reconcileAcceptance(hint, actor);
    return this.state(actor);
  }

  /** Internal verified-inbox consumer: only canonical event/customer/wallet reads can activate. */
  async reconcileAcceptedInvitation(hint: {
    eventId: string;
    invitationId: string;
  }): Promise<'processed' | 'retry' | 'quarantined'> {
    return this.reconcileAcceptance(hint);
  }

  private async reconcileAcceptance(
    hint: { eventId: string; invitationId: string },
    actor?: AccountPrincipal,
  ): Promise<'processed' | 'retry' | 'quarantined'> {
    if (!this.config.enabled) return 'retry';
    if (!providerId('evt', hint.eventId) || !providerId('adi', hint.invitationId))
      return 'quarantined';
    const claimed = await this.db.transaction().execute(async (tx) => {
      if (actor) await this.authorize(tx, actor);
      const row = (
        await sql<Row>`SELECT * FROM natural_production_connections
        WHERE invitation_id=${hint.invitationId} FOR UPDATE`.execute(tx)
      ).rows[0];
      if (!row) return { result: 'retry' as const }; // The signed event may beat the create response.
      if (actor && row.account_id !== actor.userId)
        throw new ProductionConnectionError('CONNECTION_BINDING_CHANGED');
      try {
        this.compatible(row, actor?.phoneHash);
      } catch {
        return { result: 'quarantined' as const };
      }
      if (row.accepted_event_id && row.accepted_event_id !== hint.eventId)
        return { result: 'quarantined' as const };
      // This is historical activation evidence, never current authority to debit a customer.
      if (row.status === 'connected') return { result: 'processed' as const };
      if (row.status === 'blocked' && !actor) return { result: 'quarantined' as const };
      if (row.lease_until && row.lease_until > this.clock()) return { result: 'retry' as const };
      const phone = (
        await sql<{ phone_hash: string }>`SELECT phone_hash FROM identity_phone_bindings
        WHERE user_id=${row.account_id}::uuid FOR SHARE`.execute(tx)
      ).rows[0];
      if (phone?.phone_hash !== row.phone_hash) return { result: 'quarantined' as const };
      let recheckId: string | null = null;
      if (actor) {
        const inbox = (
          await sql<{
            quarantine_reason: string | null;
            conflict_count: number;
            resource_id: string;
            event_type: string;
          }>`
          SELECT quarantine_reason,conflict_count,resource_id,event_type FROM natural_webhook_inbox
          WHERE environment='production' AND platform_party_id=${row.platform_party_id}
            AND agent_id=${row.agent_id} AND event_id=${hint.eventId} FOR UPDATE`.execute(tx)
        ).rows[0];
        // A user retry cannot dismiss a payload conflict or an unrelated source.
        if (
          inbox &&
          (inbox.resource_id !== hint.invitationId ||
            inbox.event_type !== 'agent_delegation_invitation.accepted' ||
            inbox.conflict_count > 0 ||
            (inbox.quarantine_reason !== null &&
              inbox.quarantine_reason !== 'acceptance_binding_unverified'))
        )
          return { result: 'quarantined' as const };
        const recent = await sql`SELECT id FROM natural_production_connection_rechecks
          WHERE connection_id=${row.id}::uuid
            AND started_at>${new Date(this.clock().getTime() - RECHECK_INTERVAL_MS)}
          LIMIT 1`.execute(tx);
        if (recent.rows.length) return { result: 'retry' as const };
        recheckId = randomUUID();
        await sql`INSERT INTO natural_production_connection_rechecks
          (id,connection_id,event_id,previous_status,previous_quarantine_reason,started_at)
          VALUES(${recheckId}::uuid,${row.id}::uuid,${hint.eventId},${row.status},
            ${inbox?.quarantine_reason ?? null},${this.clock()})`.execute(tx);
      }
      const claimed = (
        await sql<Row>`UPDATE natural_production_connections SET status='verifying',
        accepted_event_id=${hint.eventId},lease_token=${randomUUID()}::uuid,
        lease_until=${new Date(this.clock().getTime() + LEASE_MS)},generation=generation+1,updated_at=${this.clock()}
        WHERE id=${row.id}::uuid RETURNING *`.execute(tx)
      ).rows[0]!;
      return { row: claimed, recheckId };
    });
    if ('result' in claimed) return claimed.result;
    const row = claimed.row;
    let result: 'processed' | 'retry' | 'quarantined' = 'retry';
    try {
      const connection = await this.gateway.verifyAcceptedConnection({
        eventId: hint.eventId,
        invitationId: hint.invitationId,
        perTransactionLimitMinor: row.per_transaction_limit_minor,
      });
      if (
        !connection.invitationAccepted ||
        connection.moneyMovementEnabled !== false ||
        connection.agentId !== row.agent_id ||
        !providerId('pty', connection.customerPartyId) ||
        connection.customerPartyId === row.platform_party_id ||
        !providerId('dlg', connection.delegationId) ||
        !Number.isInteger(connection.perTransactionLimitMinor) ||
        connection.perTransactionLimitMinor < 1 ||
        connection.perTransactionLimitMinor > row.per_transaction_limit_minor
      )
        throw new ProductionConnectionError('CONNECTION_BINDING_MISMATCH');
      const wallet = await this.gateway.getReceivingWallet(connection.customerPartyId);
      // Missing balance/currency is unavailable evidence, not a permanent identity failure.
      if (wallet.currency === null) throw new Error('Wallet currency is unavailable.');
      if (
        !providerId('wal', wallet.id) ||
        wallet.partyId !== connection.customerPartyId ||
        wallet.status !== 'active' ||
        wallet.walletType !== 'standard' ||
        wallet.agentDefault !== true ||
        wallet.currency !== 'USD'
      )
        throw new ProductionConnectionError('WALLET_BINDING_MISMATCH');
      const saved = await this.db.transaction().execute(async (tx) => {
        const current = (
          await sql<Row>`SELECT * FROM natural_production_connections WHERE id=${row.id}::uuid FOR UPDATE`.execute(
            tx,
          )
        ).rows[0]!;
        if (
          current.lease_token !== row.lease_token ||
          current.generation !== row.generation ||
          !current.lease_until ||
          current.lease_until <= this.clock()
        )
          return false;
        const phone = (
          await sql<{ phone_hash: string }>`SELECT phone_hash FROM identity_phone_bindings
          WHERE user_id=${row.account_id}::uuid FOR SHARE`.execute(tx)
        ).rows[0];
        if (phone?.phone_hash !== row.phone_hash)
          throw new ProductionConnectionError('PHONE_BINDING_CHANGED');
        const inbox = (
          await sql<{
            quarantine_reason: string | null;
            conflict_count: number;
            resource_id: string;
            event_type: string;
          }>`
          SELECT quarantine_reason,conflict_count,resource_id,event_type FROM natural_webhook_inbox
          WHERE environment='production' AND platform_party_id=${row.platform_party_id}
            AND agent_id=${row.agent_id} AND event_id=${hint.eventId} FOR UPDATE`.execute(tx)
        ).rows[0];
        if (
          inbox &&
          (inbox.resource_id !== hint.invitationId ||
            inbox.event_type !== 'agent_delegation_invitation.accepted' ||
            inbox.conflict_count > 0 ||
            (inbox.quarantine_reason !== null &&
              inbox.quarantine_reason !== 'acceptance_binding_unverified'))
        )
          throw new ProductionConnectionError('ACCEPTANCE_EVENT_CONFLICT');
        await sql`UPDATE natural_production_connections SET status='connected',customer_party_id=${connection.customerPartyId},
          delegation_id=${connection.delegationId},wallet_id=${wallet.id},last_verified_at=${this.clock()},
          effective_per_transaction_limit_minor=${connection.perTransactionLimitMinor},
          lease_token=NULL,lease_until=NULL,updated_at=${this.clock()} WHERE id=${row.id}::uuid`.execute(
          tx,
        );
        if (claimed.recheckId) {
          // Resolve only the exact acceptance previously blocked by canonical checking.
          // Its prior reason remains in the recheck journal; conflict quarantines stay intact.
          await sql`UPDATE natural_webhook_inbox SET status='processed',quarantine_reason=NULL,
            processed_at=${this.clock()},lease_token=NULL,lease_until=NULL
            WHERE environment='production' AND platform_party_id=${row.platform_party_id}
              AND agent_id=${row.agent_id} AND event_id=${hint.eventId}
              AND resource_id=${hint.invitationId} AND event_type='agent_delegation_invitation.accepted'
              AND status='quarantined' AND quarantine_reason='acceptance_binding_unverified'
              AND conflict_count=0`.execute(tx);
        }
        return true;
      });
      result = saved ? 'processed' : 'retry';
      return result;
    } catch (error) {
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error ? error.reason : null;
      const invalid =
        error instanceof ProductionConnectionError ||
        reason === 'binding_mismatch' ||
        reason === 'invalid_response';
      const saved = await sql<{
        id: string;
      }>`UPDATE natural_production_connections SET status=${invalid ? 'blocked' : 'pending'},
        lease_token=NULL,lease_until=NULL,updated_at=${this.clock()}
        WHERE id=${row.id}::uuid AND lease_token=${row.lease_token}::uuid AND generation=${row.generation}
          AND lease_until>${this.clock()} RETURNING id`.execute(this.db);
      if (saved.rows.length === 0) return 'retry';
      result = invalid ? 'quarantined' : 'retry';
      return result;
    } finally {
      if (claimed.recheckId)
        await sql`UPDATE natural_production_connection_rechecks
          SET completed_at=${this.clock()},result=${result}
          WHERE id=${claimed.recheckId}::uuid AND completed_at IS NULL`.execute(this.db);
    }
  }
}
