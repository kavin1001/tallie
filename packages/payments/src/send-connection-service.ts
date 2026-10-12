import { randomUUID } from 'node:crypto';
import { phoneDemoEnabled, type AccountPrincipal } from '@tallie/identity';
import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely';
import type { SandboxAccountState, SandboxConnectionStatus } from './contracts';
import {
  SandboxGatewayError,
  type SandboxInvitation,
  type SandboxOnboardingGateway,
} from './gateway';
import type { PaymentDatabase, SandboxPhase, StoredSandboxBalance } from './schema';
import { SandboxOnboardingError } from './service';

type Connection = Selectable<PaymentDatabase['natural_sandbox_send_connections']>;
type Db = Kysely<PaymentDatabase>;
type Tx = Transaction<PaymentDatabase>;
const LEASE_MS = 30_000;
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const REFRESH_COOLDOWN_MS = 5_000;
const RECENT_ASSURANCE_MS = 15 * 60_000;
export const SANDBOX_SEND_PERMISSIONS = [
  'party.read',
  'wallets.read',
  'wallets.balance',
  'payments.read',
  'payments.create',
] as const;
const phaseStatus: Record<SandboxPhase, SandboxConnectionStatus> = {
  invite: 'inviting',
  accept: 'accepting',
  verify: 'verifying',
  balances: 'verifying',
};
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((value) => b.includes(value));

export interface SandboxSendConnectionConfig {
  enabled?: boolean;
  environment: 'sandbox';
  platformPartyId: string;
  agentId: string;
  permissions: readonly string[];
}

/** A separate synthetic grant for sandbox request/payment testing. No payment command exists here. */
export class SandboxSendConnectionService {
  private readonly config: Readonly<SandboxSendConnectionConfig>;

  constructor(
    private readonly db: Db,
    private readonly gateway: SandboxOnboardingGateway,
    config: SandboxSendConnectionConfig,
    private readonly clock = () => new Date(),
  ) {
    if (config.environment !== 'sandbox') throw new Error('Only sandbox setup is supported.');
    if (
      config.enabled &&
      (!config.platformPartyId ||
        !config.agentId ||
        config.permissions.length === 0 ||
        !sameSet(config.permissions, SANDBOX_SEND_PERMISSIONS))
    )
      throw new Error(
        'Sandbox sending requires the exact permission set and explicit party/agent configuration.',
      );
    this.config = Object.freeze({ ...config, permissions: Object.freeze([...config.permissions]) });
  }

  private assertEnabled() {
    if (!this.config.enabled)
      throw new SandboxOnboardingError(
        'SANDBOX_UNAVAILABLE',
        'Test accounts are unavailable.',
        503,
      );
  }

  private async authorize(tx: Db, actor: AccountPrincipal, recent = false): Promise<void> {
    // The marked phone-demo exception provisions synthetic sandbox customers only.
    // It must never be reused as production payment authority or debit consent.
    const result = await sql<{
      id: string;
      assurance_at: Date | null;
      assurance_kind: string;
    }>`
      SELECT s.id, s.assurance_at, s.assurance_kind FROM auth_session s
      JOIN auth_user u ON u.id=s.user_id
      JOIN identity_phone_bindings p ON p.user_id=u.id
      WHERE s.id=${actor.sessionId}::uuid AND s.user_id=${actor.userId}::uuid
        AND s.expires_at>${this.clock()} AND p.phone_hash=${actor.phoneHash}
        AND (s.assurance_kind IN ('passkey','recovery') OR (
          ${phoneDemoEnabled()} AND s.assurance_kind='phone_demo' AND u.phone_demo
          AND NOT EXISTS(SELECT 1 FROM auth_passkey WHERE user_id=u.id)
        ))
      FOR SHARE OF s,u,p
    `.execute(tx);
    if (!result.rows.length)
      throw new SandboxOnboardingError('AUTH_REQUIRED', 'Sign in again to continue.', 401);
    const assuranceAt = result.rows[0]!.assurance_at;
    if (
      recent &&
      result.rows[0]!.assurance_kind !== 'phone_demo' &&
      (!assuranceAt || this.clock().getTime() - assuranceAt.getTime() > RECENT_ASSURANCE_MS)
    )
      throw new SandboxOnboardingError(
        'STEP_UP_REQUIRED',
        'Use your passkey again to continue.',
        403,
      );
  }

  private compatible(row: Connection, actor: AccountPrincipal) {
    if (
      row.account_id !== actor.userId ||
      row.phone_hash !== actor.phoneHash ||
      row.environment !== this.config.environment ||
      row.platform_party_id !== this.config.platformPartyId ||
      row.agent_id !== this.config.agentId ||
      !sameSet(row.permissions, this.config.permissions)
    )
      throw new SandboxOnboardingError(
        'SANDBOX_CONFIGURATION_CHANGED',
        'This test account needs a setup review.',
      );
  }

  private withinRetryWindow(row: Connection): boolean {
    if (row.phase === 'verify' || row.phase === 'balances') return true;
    return (
      row.first_submission_at !== null &&
      this.clock().getTime() - row.first_submission_at.getTime() >= 0 &&
      this.clock().getTime() - row.first_submission_at.getTime() < RETRY_WINDOW_MS
    );
  }

  private busy(row: Connection): boolean {
    return row.lease_until !== null && row.lease_until.getTime() > this.clock().getTime();
  }

  private dto(row: Connection | undefined): SandboxAccountState {
    let status = row?.status;
    if (row && ['inviting', 'accepting', 'verifying'].includes(row.status) && !this.busy(row))
      status = 'unknown';
    return {
      environment: 'sandbox',
      available: this.config.enabled === true,
      moneyMovementEnabled: false,
      connection: row
        ? {
            id: row.id,
            status: status!,
            retryAllowed: status === 'unknown' && this.withinRetryWindow(row),
            balances:
              status === 'connected'
                ? row.balances.map(({ id, currency, availableMinor, totalMinor }) => ({
                    id,
                    currency,
                    availableMinor,
                    totalMinor,
                  }))
                : [],
            updatedAt: row.updated_at.toISOString(),
          }
        : null,
    };
  }

  async state(actor: AccountPrincipal): Promise<SandboxAccountState> {
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor);
      if (!this.config.enabled) return this.dto(undefined);
      const row = await tx
        .selectFrom('natural_sandbox_send_connections')
        .selectAll()
        .where('account_id', '=', actor.userId)
        .executeTakeFirst();
      if (row) this.compatible(row, actor);
      return this.dto(row);
    });
  }

  /** One click prepares stable operation identities before any external mutation. */
  async start(actor: AccountPrincipal): Promise<SandboxAccountState> {
    this.assertEnabled();
    const claimed = await this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, true);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`natural-sandbox-send:${actor.userId}`},0))`.execute(
        tx,
      );
      let row = await tx
        .selectFrom('natural_sandbox_send_connections')
        .selectAll()
        .where('account_id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (row) {
        this.compatible(row, actor);
        return null;
      }
      const now = this.clock();
      row = await tx
        .insertInto('natural_sandbox_send_connections')
        .values({
          id: randomUUID(),
          account_id: actor.userId,
          environment: 'sandbox',
          phone_hash: actor.phoneHash,
          platform_party_id: this.config.platformPartyId,
          agent_id: this.config.agentId,
          permissions: JSON.stringify(this.config.permissions),
          status: 'prepared',
          phase: 'invite',
          invite_operation_id: randomUUID(),
          invite_idempotency_key: randomUUID(),
          accept_operation_id: randomUUID(),
          accept_idempotency_key: randomUUID(),
          invitation_id: null,
          customer_party_id: null,
          delegation_id: null,
          balances: '[]',
          first_submission_at: null,
          lease_until: null,
          generation: 0,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.claim(tx, row);
    });
    if (claimed) await this.drive(actor, claimed, true);
    return this.state(actor);
  }

  /** Retries are explicit, retain the original mutation identities, and stop after 24 hours. */
  async retry(actor: AccountPrincipal): Promise<SandboxAccountState> {
    this.assertEnabled();
    const row = await this.claimExisting(actor, 'retry');
    if (row) await this.drive(actor, row, true);
    return this.state(actor);
  }

  /** Canonical customer access is checked again before any refreshed wallet snapshot. */
  async refresh(actor: AccountPrincipal): Promise<SandboxAccountState> {
    this.assertEnabled();
    const row = await this.claimExisting(actor, 'refresh');
    if (row) await this.drive(actor, row, false);
    return this.state(actor);
  }

  private async claimExisting(actor: AccountPrincipal, kind: 'retry' | 'refresh') {
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, kind === 'retry');
      const row = await tx
        .selectFrom('natural_sandbox_send_connections')
        .selectAll()
        .where('account_id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      this.compatible(row, actor);
      if (this.busy(row) || row.status === 'blocked') return null;
      if (kind === 'refresh') {
        if (row.status !== 'connected') return null;
        if (this.clock().getTime() - row.updated_at.getTime() < REFRESH_COOLDOWN_MS) return null;
        return this.claim(tx, { ...row, phase: 'verify' });
      }
      if (row.status === 'connected') return null;
      if (!this.withinRetryWindow(row))
        throw new SandboxOnboardingError(
          'SANDBOX_RETRY_EXPIRED',
          'This test account needs a setup review before another attempt.',
        );
      // Revalidate delegation before resuming a previously interrupted wallet read.
      return this.claim(tx, row.phase === 'balances' ? { ...row, phase: 'verify' } : row);
    });
  }

  private claim(tx: Tx, row: Connection) {
    const now = this.clock();
    return tx
      .updateTable('natural_sandbox_send_connections')
      .set({
        phase: row.phase,
        status: phaseStatus[row.phase],
        generation: row.generation + 1,
        lease_until: new Date(now.getTime() + LEASE_MS),
        first_submission_at: row.first_submission_at ?? now,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private invitationMatches(invitation: SandboxInvitation, row: Connection): boolean {
    return (
      Boolean(invitation.id) &&
      invitation.agentId === row.agent_id &&
      sameSet(invitation.permissions, row.permissions)
    );
  }

  private integrity(condition: unknown): asserts condition {
    if (!condition) throw new SandboxGatewayError('SANDBOX_RESPONSE_MISMATCH', 'rejected');
  }

  /** Record returned evidence even if the browser session expires in flight; disclosure rechecks auth. */
  private async persist(
    row: Connection,
    changes: Updateable<PaymentDatabase['natural_sandbox_send_connections']>,
  ): Promise<Connection | null> {
    return (
      (await this.db
        .updateTable('natural_sandbox_send_connections')
        .set(changes)
        .set({ updated_at: this.clock() })
        .where('id', '=', row.id)
        .where('generation', '=', row.generation)
        .where('phase', '=', row.phase)
        .where('status', '=', phaseStatus[row.phase])
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  }

  private async continueAuthorized(
    actor: AccountPrincipal,
    row: Connection,
    recent: boolean,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await this.authorize(tx, actor, recent);
      const current = await tx
        .selectFrom('natural_sandbox_send_connections')
        .selectAll()
        .where('id', '=', row.id)
        .where('account_id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.generation !== row.generation || current.phase !== row.phase)
        return false;
      this.compatible(current, actor);
      if (!this.busy(current)) return false;
      await tx
        .updateTable('natural_sandbox_send_connections')
        .set({
          lease_until: new Date(this.clock().getTime() + LEASE_MS),
        })
        .where('id', '=', row.id)
        .execute();
      return true;
    });
  }

  private async drive(
    actor: AccountPrincipal,
    initial: Connection,
    recent: boolean,
  ): Promise<void> {
    let row: Connection | null = initial;
    // Four bounded phases; no recursion, generic automatic retries, or provider calls in transactions.
    for (let step = 0; row && step < 4; step += 1) {
      if (!(await this.continueAuthorized(actor, row, recent))) return;
      const attempted = row;
      try {
        if (row.phase === 'invite') {
          const result = await this.gateway.createInvitation({
            operationId: row.invite_operation_id,
            idempotencyKey: row.invite_idempotency_key,
            agentId: row.agent_id,
            permissions: [...row.permissions],
          });
          const invitation = result.invitations[0];
          this.integrity(
            result.invitations.length === 1 &&
              invitation &&
              this.invitationMatches(invitation, row) &&
              invitation.status === 'PENDING' &&
              invitation.effectiveStatus === 'PENDING' &&
              Boolean(result.customerPartyId) &&
              result.customerPartyId !== row.platform_party_id &&
              (invitation.customerPartyId === null ||
                invitation.customerPartyId === result.customerPartyId),
          );
          row = await this.persist(row, {
            invitation_id: invitation.id,
            customer_party_id: result.customerPartyId,
            phase: 'accept',
            status: 'accepting',
          });
        } else if (row.phase === 'accept') {
          this.integrity(row.invitation_id && row.customer_party_id);
          const invitation = await this.gateway.acceptInvitation({
            invitationId: row.invitation_id,
            customerPartyId: row.customer_party_id,
            agentId: row.agent_id,
            operationId: row.accept_operation_id,
            idempotencyKey: row.accept_idempotency_key,
          });
          this.integrity(
            this.invitationMatches(invitation, row) &&
              invitation.id === row.invitation_id &&
              invitation.customerPartyId === row.customer_party_id &&
              invitation.status === 'ACCEPTED' &&
              invitation.effectiveStatus === 'ACCEPTED',
          );
          row = await this.persist(row, { phase: 'verify', status: 'verifying' });
        } else if (row.phase === 'verify') {
          this.integrity(row.customer_party_id);
          const customer = await this.gateway.getCustomer(row.customer_party_id);
          const agents = customer.agents.filter((agent) => agent.id === row!.agent_id);
          this.integrity(
            customer.id === row.customer_party_id &&
              customer.id !== row.platform_party_id &&
              customer.delegation.id &&
              (!row.delegation_id || customer.delegation.id === row.delegation_id) &&
              customer.delegation.status === 'ACTIVE' &&
              sameSet(customer.delegation.permissions, row.permissions) &&
              agents.length === 1 &&
              agents[0]!.status === 'ACTIVE' &&
              sameSet(agents[0]!.permissions, row.permissions),
          );
          row = await this.persist(row, {
            delegation_id: customer.delegation.id,
            phase: 'balances',
            status: 'verifying',
          });
        } else {
          this.integrity(row.customer_party_id);
          const wallets = await this.gateway.listWallets(row.customer_party_id);
          this.integrity(new Set(wallets.map((wallet) => wallet.id)).size === wallets.length);
          const balances: StoredSandboxBalance[] = [];
          for (const wallet of wallets) {
            this.integrity(wallet.id && wallet.partyId === row.customer_party_id);
            if (wallet.walletType !== 'standard' || wallet.status !== 'active') continue;
            this.integrity(
              wallet.balance === null ||
                (wallet.balance.currency === 'USD' &&
                  /^-?\d+$/.test(wallet.balance.available) &&
                  /^-?\d+$/.test(wallet.balance.total)),
            );
            balances.push({
              id:
                row.balances.find((previous) => previous.providerWalletId === wallet.id)?.id ??
                randomUUID(),
              providerWalletId: wallet.id,
              currency: 'USD',
              availableMinor: wallet.balance?.available ?? null,
              totalMinor: wallet.balance?.total ?? null,
            });
          }
          await this.persist(row, {
            status: 'connected',
            balances: JSON.stringify(balances),
            lease_until: null,
          });
          return;
        }
      } catch (error) {
        await this.persist(attempted, {
          status:
            error instanceof SandboxGatewayError && error.outcome === 'rejected'
              ? 'blocked'
              : 'unknown',
          lease_until: null,
        });
        return;
      }
    }
  }
}
