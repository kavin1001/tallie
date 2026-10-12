import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';
import type { SandboxPayment, SandboxSendGateway } from './send-service';
import { saveSandboxPaymentObservation, SandboxObservationMismatch } from './payment-observation';

const LEASE_MS = 90_000;
const DAY_MS = 86_400_000;
// A bounded polling policy, not a promise that a payment can no longer return.
const COMPLETED_MONITOR_MS = 60 * DAY_MS;
const TERMINAL = ['FAILED', 'RETURNED', 'APPROVAL_DENIED', 'CANCELED'];

export interface SandboxDepositObservation {
  id: string;
  type: 'deposit';
  partyId: string;
  walletId: string;
  amount: number;
  currency: 'USD';
  status: string;
}

/** Intentionally excludes all mutation capabilities and provisioning credentials. */
export interface SandboxReconciliationGateway {
  getPayment: SandboxSendGateway['getPayment'];
  listPayments: SandboxSendGateway['listPayments'];
  getDeposit(input: {
    customerPartyId: string;
    walletId: string;
    amount: number;
    transferId: string;
  }): Promise<SandboxDepositObservation>;
}

export interface SandboxReconciliationHint {
  kind: 'send' | 'funding';
  providerId?: string;
  operationId?: string;
}

type Attention =
  | 'provider_unavailable'
  | 'binding_mismatch'
  | 'unresolved_operation'
  | 'deposit_identity_unknown'
  | 'monitor_window_closed';
type Job = {
  id: string;
  send_id: string | null;
  funding_id: string | null;
  lease_token: string;
  lease_until: Date;
  generation: number;
  wake_version: string;
  attempts: number;
  consecutive_failures: number;
  scan_cursor: string | null;
  completed_at: Date | null;
};
type Operation = {
  id: string;
  operation_id: string;
  provider_id: string | null;
  status: string;
  sender_party_id: string;
  recipient_party_id: string | null;
  wallet_id: string;
  amount_minor: number;
  lease_until: Date | null;
  created_at: Date;
};
type Observation = {
  payment?: SandboxPayment;
  deposit?: SandboxDepositObservation;
  cursor?: string | null;
  error?: Attention;
  pause?: boolean;
};

/** Durable bounded canonical reads. The caller owns the maintenance loop. */
export class SandboxPaymentReconciliationService {
  constructor(
    private readonly db: Kysely<PaymentDatabase>,
    private readonly gateway: SandboxReconciliationGateway,
    private readonly agentId: string,
    private readonly platformPartyId: string,
    private readonly clock = () => new Date(),
  ) {
    if (!agentId || !platformPartyId)
      throw new Error('Reconciliation configuration is incomplete.');
  }

  /** A verified event is a wake-up hint; it cannot create an operation or set its status. */
  async wake(hint: SandboxReconciliationHint): Promise<number> {
    if (
      !['send', 'funding'].includes(hint.kind) ||
      (!hint.providerId && !hint.operationId) ||
      (hint.providerId?.length ?? 0) > 256 ||
      (hint.operationId?.length ?? 0) > 128
    )
      return 0;
    const now = this.clock();
    const matched =
      hint.kind === 'send'
        ? sql`j.send_id IN (
            SELECT s.id FROM natural_sandbox_sends s
            JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
            JOIN natural_sandbox_send_connections c ON c.id=r.sender_connection_id
            WHERE c.environment='sandbox' AND c.agent_id=${this.agentId}
              AND c.platform_party_id=${this.platformPartyId}
              AND (${hint.providerId ?? null}::text IS NULL OR s.provider_payment_id=${hint.providerId ?? null}
                OR (s.provider_payment_id IS NULL AND ${hint.operationId ?? null}::text IS NOT NULL))
              AND (${hint.operationId ?? null}::text IS NULL OR s.operation_id::text=${hint.operationId ?? null})
          )`
        : sql`j.funding_id IN (
            SELECT f.id FROM natural_sandbox_funding f
            JOIN natural_sandbox_send_connections c ON c.id=f.sender_connection_id
            WHERE c.environment='sandbox' AND c.agent_id=${this.agentId}
              AND c.platform_party_id=${this.platformPartyId}
              AND (${hint.providerId ?? null}::text IS NULL OR f.provider_transfer_id=${hint.providerId ?? null}
                OR (f.provider_transfer_id IS NULL AND ${hint.operationId ?? null}::text IS NOT NULL))
              AND (${hint.operationId ?? null}::text IS NULL OR f.operation_id::text=${hint.operationId ?? null})
          )`;
    const result = await sql<{ id: string }>`
      UPDATE natural_sandbox_reconciliation_jobs j
      SET status='ready',available_at=${now},wake_version=wake_version+1,updated_at=${now}
      WHERE ${matched} RETURNING id
    `.execute(this.db);
    return result.rows.length;
  }

  private async claim(): Promise<Job | null> {
    const now = this.clock();
    return this.db.transaction().execute(async (tx) => {
      const result = await sql<Job>`
        SELECT j.* FROM natural_sandbox_reconciliation_jobs j
        LEFT JOIN natural_sandbox_sends s ON s.id=j.send_id
        LEFT JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
        LEFT JOIN natural_sandbox_funding f ON f.id=j.funding_id
        JOIN natural_sandbox_send_connections c ON c.id=COALESCE(r.sender_connection_id,f.sender_connection_id)
        WHERE j.status='ready' AND j.available_at<=${now}
          AND (j.lease_until IS NULL OR j.lease_until<=${now})
          AND (COALESCE(s.lease_until,f.lease_until) IS NULL OR COALESCE(s.lease_until,f.lease_until)<=${now})
          AND c.environment='sandbox' AND c.agent_id=${this.agentId}
          AND c.platform_party_id=${this.platformPartyId}
        ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      `.execute(tx);
      const row = result.rows[0];
      if (!row) return null;
      const claimed = await sql<Job>`
        UPDATE natural_sandbox_reconciliation_jobs SET lease_token=${randomUUID()}::uuid,
          lease_until=${new Date(now.getTime() + LEASE_MS)},generation=generation+1,
          attempts=attempts+1,updated_at=${now}
        WHERE id=${row.id}::uuid RETURNING *
      `.execute(tx);
      return claimed.rows[0]!;
    });
  }

  private async operation(job: Job, db = this.db, lock = false): Promise<Operation> {
    const result = job.send_id
      ? await sql<Operation>`
          SELECT s.id,s.operation_id,s.provider_payment_id AS provider_id,s.status,
            r.sender_party_id,r.recipient_party_id,r.sender_wallet_id AS wallet_id,
            r.amount_minor,s.lease_until,s.created_at
          FROM natural_sandbox_sends s JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
          WHERE s.id=${job.send_id}::uuid
          ${lock ? sql`FOR UPDATE OF s` : sql``}
        `.execute(db)
      : await sql<Operation>`
          SELECT id,operation_id,provider_transfer_id AS provider_id,status,
            customer_party_id AS sender_party_id,NULL::text AS recipient_party_id,
            wallet_id,amount_minor,lease_until,created_at
          FROM natural_sandbox_funding WHERE id=${job.funding_id}::uuid
          ${lock ? sql`FOR UPDATE` : sql``}
        `.execute(db);
    if (!result.rows[0]) throw new Error('Reconciliation operation is missing.');
    return result.rows[0];
  }

  private async observe(job: Job, operation: Operation): Promise<Observation> {
    if (operation.sender_party_id === this.platformPartyId) return { error: 'binding_mismatch' };
    if (!job.send_id) {
      if (!operation.provider_id) return { error: 'deposit_identity_unknown', pause: true };
      return {
        deposit: await this.gateway.getDeposit({
          customerPartyId: operation.sender_party_id,
          walletId: operation.wallet_id,
          amount: operation.amount_minor,
          transferId: operation.provider_id,
        }),
      };
    }
    if (operation.provider_id)
      return {
        payment: await this.gateway.getPayment({
          senderPartyId: operation.sender_party_id,
          recipientPartyId: operation.recipient_party_id!,
          amount: operation.amount_minor,
          paymentId: operation.provider_id,
        }),
      };
    let cursor = job.scan_cursor;
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const batch = await this.gateway.listPayments({
        senderPartyId: operation.sender_party_id,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const candidates = batch.payments.filter(
        (payment) => payment.tags.app_operation_id === operation.operation_id,
      );
      if (candidates.length > 1) return { error: 'binding_mismatch' };
      if (candidates[0]) return { payment: candidates[0], cursor: null };
      if (!batch.hasMore) return { cursor: null, error: 'unresolved_operation' };
      if (!batch.nextCursor || batch.nextCursor === cursor || seen.has(batch.nextCursor))
        return { error: 'provider_unavailable', cursor: null };
      seen.add(batch.nextCursor);
      cursor = batch.nextCursor;
    }
    // Continue this bounded scan on the next claim; exhaustion never proves absence.
    return { cursor, error: 'unresolved_operation' };
  }

  private async saveDeposit(
    tx: Kysely<PaymentDatabase>,
    row: Operation,
    value: SandboxDepositObservation,
  ) {
    if (
      value.id !== row.provider_id ||
      value.type !== 'deposit' ||
      value.partyId !== row.sender_party_id ||
      value.walletId !== row.wallet_id ||
      value.amount !== row.amount_minor ||
      value.currency !== 'USD'
    )
      throw new SandboxObservationMismatch();
    await sql`
      UPDATE natural_sandbox_funding SET status=CASE
        WHEN status IN ('RETURNED','FAILED','APPROVAL_DENIED','CANCELED') THEN status
        WHEN status='COMPLETED' AND ${value.status}<>'RETURNED' THEN status
        WHEN status IN ('PROCESSING','IN_REVIEW') AND ${value.status}='CREATED' THEN status
        ELSE ${value.status} END,
        lease_until=NULL,updated_at=${this.clock()}
      WHERE id=${row.id}::uuid AND provider_transfer_id=${value.id}
    `.execute(tx);
  }

  private async finish(job: Job, observation: Observation): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const now = this.clock();
      // Journal → job matches enqueue triggers used by browser commands. Inverting
      // this order would deadlock a concurrent submission/observation transaction.
      const row = await this.operation(job, tx, true);
      const locked = (
        await sql<Job>`
        SELECT * FROM natural_sandbox_reconciliation_jobs
        WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid
          AND generation=${job.generation} AND lease_until>${now}
        FOR UPDATE
      `.execute(tx)
      ).rows[0];
      if (!locked) return;
      let error = observation.error ?? null;
      try {
        if (observation.payment)
          await saveSandboxPaymentObservation(
            tx,
            {
              ...row,
              recipient_party_id: row.recipient_party_id!,
            },
            observation.payment,
            this.agentId,
            now,
          );
        if (observation.deposit) await this.saveDeposit(tx, row, observation.deposit);
      } catch (caught) {
        if (!(caught instanceof SandboxObservationMismatch)) throw caught;
        error = 'binding_mismatch';
      }
      if (
        !observation.payment &&
        !observation.deposit &&
        row.status === 'submitting' &&
        (!row.lease_until || row.lease_until <= now)
      ) {
        const table = job.send_id
          ? sql.table('natural_sandbox_sends')
          : sql.table('natural_sandbox_funding');
        await sql`UPDATE ${table} SET status='unknown',lease_until=NULL,updated_at=${now}
          WHERE id=${row.id}::uuid AND status='submitting'`.execute(tx);
      }
      const current = await this.operation(job, tx);
      const completedAt = locked.completed_at ?? (current.status === 'COMPLETED' ? now : null);
      let paused = observation.pause ?? false;
      const failures = error ? locked.consecutive_failures + 1 : 0;
      let delay = Math.min(15_000 * 2 ** Math.min(job.attempts - 1, 6), 15 * 60_000);
      if (error) delay = Math.min(15_000 * 2 ** Math.min(failures - 1, 8), 60 * 60_000);
      if (current.provider_id && TERMINAL.includes(current.status) && !error) paused = true;
      if (current.status === 'COMPLETED' && completedAt && !error) {
        const age = Math.max(0, now.getTime() - completedAt.getTime());
        delay = age < DAY_MS ? 15 * 60_000 : 6 * 60 * 60_000;
        if (age >= COMPLETED_MONITOR_MS) {
          paused = true;
          error = 'monitor_window_closed';
        }
      }
      // A webhook arriving during the network read must not be overwritten by its schedule.
      const woken = locked.wake_version !== job.wake_version;
      await sql`
        UPDATE natural_sandbox_reconciliation_jobs SET status=${paused && !woken ? 'paused' : 'ready'},
          available_at=${woken ? now : new Date(now.getTime() + delay)},lease_token=NULL,lease_until=NULL,
          consecutive_failures=${failures},scan_cursor=${observation.cursor === undefined ? locked.scan_cursor : observation.cursor},
          completed_at=${completedAt},last_checked_at=${now},attention_reason=${error},updated_at=${now}
        WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid AND generation=${job.generation}
      `.execute(tx);
    });
  }

  async processOne(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const operation = await this.operation(job);
    let observation: Observation;
    try {
      observation = await this.observe(job, operation);
    } catch {
      observation = { error: 'provider_unavailable' };
    }
    await this.finish(job, observation);
    return true;
  }
}
