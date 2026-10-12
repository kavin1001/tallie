import { createCipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';
import { NaturalWebhookError, type VerifiedNaturalEvent } from './webhook-verification';

export type NaturalWebhookEnvironment = 'sandbox' | 'production';
export type NaturalReconciliationHint = {
  kind: 'send' | 'funding';
  providerId?: string;
  operationId?: string;
};
export interface NaturalWebhookInboxOptions {
  environment: NaturalWebhookEnvironment;
  platformPartyId: string;
  agentId: string;
  encryptionKey?: string;
}
export type NaturalAcceptanceHint = { eventId: string; invitationId: string };
export type NaturalAcceptanceResult = 'processed' | 'retry' | 'quarantined';
const ACCEPTED_EVENT = 'agent_delegation_invitation.accepted';
type InboxRow = {
  id: string;
  event_id: string;
  event_type: string;
  source_party_id: string;
  resource_type: string;
  resource_id: string;
  operation_id: string | null;
  attempts: number;
  lease_token: string;
  received_at: Date;
};
const supported = new Set([
  'payment.created',
  'payment.completed',
  'payment.failed',
  'payment.returned',
  'payment.canceled',
  'payment.approval_denied',
  'deposit.created',
  'deposit.completed',
  'deposit.failed',
  'deposit.returned',
  'deposit.canceled',
  'deposit.approval_denied',
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Durable event hints. This class has no provider mutation or settlement API. */
export class NaturalWebhookInboxService {
  private readonly encryptionKey: Buffer | null;
  constructor(
    private readonly db: Kysely<PaymentDatabase>,
    private readonly options: NaturalWebhookInboxOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (
      !['sandbox', 'production'].includes(options.environment) ||
      !/^pty_[a-f0-9]{32}$/.test(options.platformPartyId) ||
      !/^agt_[a-f0-9]{32}$/.test(options.agentId) ||
      (options.encryptionKey !== undefined && !/^[a-f0-9]{64}$/i.test(options.encryptionKey))
    )
      throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
    this.encryptionKey = options.encryptionKey
      ? Buffer.from(
          hkdfSync(
            'sha256',
            Buffer.from(options.encryptionKey, 'hex'),
            'tallie',
            'natural-webhook-inbox-v1',
            32,
          ),
        )
      : null;
  }
  private seal(raw: Buffer, id: string): string {
    if (!this.encryptionKey) throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${this.options.environment}:${this.options.platformPartyId}:${id}`));
    const payload = Buffer.concat([cipher.update(raw), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      payload.toString('base64url'),
    ].join('.');
  }
  private async knownSource(source: string): Promise<boolean> {
    if (source === this.options.platformPartyId) return true;
    // Keep historical bindings: a revoked delegation must not discard a return.
    const result = await sql<{ found: boolean }>`SELECT EXISTS (
      SELECT 1 FROM natural_sandbox_send_connections
      WHERE environment='sandbox' AND platform_party_id=${this.options.platformPartyId}
        AND agent_id=${this.options.agentId} AND customer_party_id=${source}
      UNION ALL SELECT 1 FROM natural_sandbox_connections
      WHERE environment='sandbox' AND platform_party_id=${this.options.platformPartyId}
        AND agent_id=${this.options.agentId} AND customer_party_id=${source}
    ) AS found`.execute(this.db);
    return result.rows[0]?.found ?? false;
  }
  async ingest(
    verified: VerifiedNaturalEvent,
  ): Promise<{ duplicate: boolean; quarantined: boolean }> {
    if (!this.encryptionKey) throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
    const { event } = verified;
    const resource = event.data.object;
    let reason: string | null = null;
    if (this.options.environment === 'production') {
      if (event.type !== ACCEPTED_EVENT) reason = 'production_processing_disabled';
      else if (
        event.resourceType !== 'agent_delegation_invitation' ||
        !/^adi_[a-f0-9]{32}$/.test(event.resourceId) ||
        resource.invitationId !== event.resourceId ||
        resource.status !== 'accepted' ||
        resource.agentId !== this.options.agentId ||
        resource.delegateePartyId !== this.options.platformPartyId ||
        typeof resource.delegatorPartyId !== 'string' ||
        !/^pty_[a-f0-9]{32}$/.test(resource.delegatorPartyId) ||
        resource.delegatorPartyId === this.options.platformPartyId ||
        ![resource.delegateePartyId, resource.delegatorPartyId].includes(event.sourcePartyId)
      )
        reason = 'acceptance_binding_mismatch';
    } else if (!supported.has(event.type)) reason = 'unsupported_event_type';
    else if (
      (event.type.startsWith('payment.') &&
        (event.resourceType !== 'payment' ||
          !/^pay_[a-f0-9]{32}$/.test(event.resourceId) ||
          resource.type !== 'payment' ||
          ![resource.senderPartyId, resource.recipientPartyId].includes(event.sourcePartyId))) ||
      (event.type.startsWith('deposit.') &&
        (event.resourceType !== 'transfer' ||
          !/^trf_[a-f0-9]{32}$/.test(event.resourceId) ||
          resource.type !== 'deposit' ||
          resource.partyId !== event.sourcePartyId))
    )
      reason = 'event_source_mismatch';
    else if (!(await this.knownSource(event.sourcePartyId))) reason = 'unknown_source_party';
    const tags = resource.tags;
    const operation =
      tags && typeof tags === 'object' && 'app_operation_id' in tags ? tags.app_operation_id : null;
    const operationId = typeof operation === 'string' && uuid.test(operation) ? operation : null;
    const now = this.clock();
    const id = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      const inserted = await sql<{ id: string }>`INSERT INTO natural_webhook_inbox (
        id,environment,platform_party_id,agent_id,event_id,event_type,source_party_id,
        resource_type,resource_id,operation_id,payload_hash,payload_ciphertext,event_created_at,
        signed_at,received_at,payload_expires_at,status,quarantine_reason,available_at
      ) VALUES (${id}::uuid,${this.options.environment},${this.options.platformPartyId},
        ${this.options.agentId},${event.id},${event.type},${event.sourcePartyId},${event.resourceType},
        ${event.resourceId},${operationId}::uuid,${verified.payloadHash},${this.seal(verified.rawBody, id)},
        ${new Date(event.createdAt)},${verified.signedAt},${now},${new Date(now.getTime() + 30 * 86400_000)},
        ${reason ? 'quarantined' : 'pending'},${reason},${now})
        ON CONFLICT(environment,platform_party_id,event_id) DO NOTHING RETURNING id`.execute(tx);
      if (inserted.rows.length) return { duplicate: false, quarantined: !!reason };
      const existing = (
        await sql<{ id: string; payload_hash: string; status: string }>`
        SELECT id,payload_hash,status FROM natural_webhook_inbox
        WHERE environment=${this.options.environment} AND platform_party_id=${this.options.platformPartyId}
          AND event_id=${event.id} FOR UPDATE`.execute(tx)
      ).rows[0];
      if (!existing) throw new Error('Webhook durable identity unavailable.');
      if (existing.payload_hash !== verified.payloadHash) {
        await sql`UPDATE natural_webhook_inbox SET status='quarantined',
          quarantine_reason='event_payload_conflict',conflict_count=conflict_count+1,
          lease_token=NULL,lease_until=NULL WHERE id=${existing.id}::uuid`.execute(tx);
        return { duplicate: true, quarantined: true };
      }
      return { duplicate: true, quarantined: existing.status === 'quarantined' };
    });
  }

  private async hint(row: InboxRow): Promise<NaturalReconciliationHint | null> {
    if (row.event_type.startsWith('payment.')) {
      const result = await sql<{ operation_id: string; provider_payment_id: string | null }>`
        SELECT s.operation_id,s.provider_payment_id FROM natural_sandbox_sends s
        JOIN natural_sandbox_send_reviews r ON r.id=s.review_id
        JOIN natural_sandbox_send_connections c ON c.id=r.sender_connection_id
        WHERE c.environment='sandbox' AND c.platform_party_id=${this.options.platformPartyId}
          AND c.agent_id=${this.options.agentId}
          AND ${row.source_party_id} IN (r.sender_party_id,r.recipient_party_id)
          AND (s.provider_payment_id=${row.resource_id} OR (
            s.provider_payment_id IS NULL AND s.operation_id=${row.operation_id}::uuid))
        LIMIT 2`.execute(this.db);
      const found = result.rows[0];
      if (result.rows.length !== 1 || !found) return null;
      // Always use the journal's operation identity; event metadata never replaces
      // it or supplies a different provider ID to a known operation.
      return {
        kind: 'send',
        operationId: found.operation_id,
        ...(found.provider_payment_id ? { providerId: found.provider_payment_id } : {}),
      };
    }
    const result = await sql<{ operation_id: string; provider_transfer_id: string }>`
      SELECT f.operation_id,f.provider_transfer_id FROM natural_sandbox_funding f
      JOIN natural_sandbox_send_connections c ON c.id=f.sender_connection_id
      WHERE c.environment='sandbox' AND c.platform_party_id=${this.options.platformPartyId}
        AND c.agent_id=${this.options.agentId} AND f.customer_party_id=${row.source_party_id}
        AND f.provider_transfer_id=${row.resource_id} LIMIT 2`.execute(this.db);
    const found = result.rows[0];
    return result.rows.length === 1 && found
      ? { kind: 'funding', operationId: found.operation_id, providerId: found.provider_transfer_id }
      : null;
  }

  private async claim(eventType: string | null): Promise<(InboxRow & { token: string }) | null> {
    const now = this.clock();
    const token = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      const selected = (
        await sql<InboxRow>`SELECT * FROM natural_webhook_inbox
        WHERE environment=${this.options.environment} AND platform_party_id=${this.options.platformPartyId}
          AND agent_id=${this.options.agentId} AND available_at<=${now}
          AND (${eventType}::text IS NULL OR event_type=${eventType})
          AND (status='pending' OR (status='processing' AND lease_until<=${now}))
        ORDER BY available_at,received_at,id FOR UPDATE SKIP LOCKED LIMIT 1`.execute(tx)
      ).rows[0];
      if (!selected) return null;
      await sql`UPDATE natural_webhook_inbox SET status='processing',attempts=attempts+1,
        lease_token=${token}::uuid,lease_until=${new Date(now.getTime() + (eventType === ACCEPTED_EVENT ? 120_000 : 60_000))}
        WHERE id=${selected.id}::uuid`.execute(tx);
      return { ...selected, attempts: selected.attempts + 1, token };
    });
  }

  private async finish(
    row: InboxRow & { token: string },
    result: NaturalAcceptanceResult,
    reason: string,
  ): Promise<void> {
    const complete = result === 'processed';
    const quarantined = result === 'quarantined' || (!complete && row.attempts >= 12);
    await sql`UPDATE natural_webhook_inbox SET
      status=${complete ? 'processed' : quarantined ? 'quarantined' : 'pending'},
      quarantine_reason=${quarantined ? reason : null},
      processed_at=${complete ? this.clock() : null},lease_token=NULL,lease_until=NULL,
      available_at=${new Date(this.clock().getTime() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)))}
      WHERE id=${row.id}::uuid AND lease_token=${row.token}::uuid AND status='processing'
        AND lease_until>${this.clock()}`.execute(this.db);
  }

  async processOne(wake: (hint: NaturalReconciliationHint) => Promise<number>): Promise<boolean> {
    // Financial events from production cannot reach the sandbox journal.
    if (this.options.environment !== 'sandbox') return false;
    const row = await this.claim(null);
    if (!row) return false;
    let result: NaturalAcceptanceResult = 'retry';
    try {
      const hint = await this.hint(row);
      if (hint !== null && (await wake(hint)) > 0) result = 'processed';
    } catch {
      /* Retain evidence and retry; never log provider data. */
    }
    await this.finish(row, result, 'reconciliation_target_unavailable');
    return true;
  }

  async processAcceptanceOne(
    reconcile: (hint: NaturalAcceptanceHint) => Promise<NaturalAcceptanceResult>,
  ): Promise<boolean> {
    if (this.options.environment !== 'production') return false;
    const row = await this.claim(ACCEPTED_EVENT);
    if (!row) return false;
    let result: NaturalAcceptanceResult = 'retry';
    try {
      // The connection service must fetch this canonical event and revalidate the
      // exact saved invitation, platform, agent and active customer delegation.
      // Neither the signed snapshot nor this hint alone activates an account.
      result = await reconcile({ eventId: row.event_id, invitationId: row.resource_id });
    } catch {
      /* A transient provider outage leaves the hint durably retryable. */
    }
    await this.finish(row, result, 'acceptance_binding_unverified');
    return true;
  }

  async purgeExpiredPayloads(): Promise<number> {
    // Identity and digest persist for duplicate detection, including old retries.
    const result = await sql`WITH expired AS (
      SELECT id FROM natural_webhook_inbox WHERE environment=${this.options.environment}
        AND platform_party_id=${this.options.platformPartyId}
        AND payload_expires_at<=${this.clock()} AND payload_ciphertext IS NOT NULL
      ORDER BY payload_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1000
    ) UPDATE natural_webhook_inbox SET payload_ciphertext=NULL
      WHERE id IN (SELECT id FROM expired)`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }
}
