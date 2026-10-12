import { sql, type Kysely } from 'kysely';
import type { PaymentDatabase } from './schema';
import type { SandboxPayment } from './send-service';

export class SandboxObservationMismatch extends Error {
  constructor() {
    super('Canonical sandbox resource does not match the saved operation.');
    this.name = 'SandboxObservationMismatch';
  }
}

/** Used by both authenticated reads and leased background reconciliation. */
export async function saveSandboxPaymentObservation(
  db: Kysely<PaymentDatabase>,
  saved: {
    id: string;
    operation_id: string;
    sender_party_id: string;
    recipient_party_id: string;
    amount_minor: number;
  },
  payment: SandboxPayment,
  agentId: string,
  now: Date,
): Promise<void> {
  if (
    payment.senderPartyId !== saved.sender_party_id ||
    payment.recipientPartyId !== saved.recipient_party_id ||
    payment.senderAgentId !== agentId ||
    payment.paymentRequestId !== null ||
    payment.amount !== saved.amount_minor ||
    payment.currency !== 'USD' ||
    payment.tags.app_operation_id !== saved.operation_id
  )
    throw new SandboxObservationMismatch();
  const updated = await sql<{ id: string }>`
    UPDATE natural_sandbox_sends
    SET provider_payment_id=${payment.id},status=CASE
      WHEN provider_payment_id IS NOT NULL AND status IN ('RETURNED','FAILED','APPROVAL_DENIED','CANCELED') THEN status
      WHEN status='COMPLETED' AND ${payment.status}<>'RETURNED' THEN status
      WHEN status IN ('PROCESSING','IN_REVIEW','PENDING_CLAIM') AND ${payment.status}='CREATED' THEN status
      ELSE ${payment.status} END,
      lease_until=NULL,updated_at=${now}
    WHERE id=${saved.id}::uuid AND (provider_payment_id IS NULL OR provider_payment_id=${payment.id})
    RETURNING id
  `.execute(db);
  if (!updated.rows.length) throw new SandboxObservationMismatch();
}
