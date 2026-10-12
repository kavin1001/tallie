import { z } from 'zod';
import {
  agentIdSchema,
  centsSchema,
  operationSchema,
  paginationSchema,
  partyIdSchema,
  paymentIdSchema,
  paymentRequestIdSchema,
  walletIdSchema,
  walletResponse,
} from './contracts';
import type { NaturalEnvironment } from './config';
import { NaturalProviderError } from './errors';
import { OwnerPilotTransport, type NaturalClientOptions } from './transport';

const handle = z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/);
const configuration = z.strictObject({
  environment: z.literal('production'),
  apiKey: z.string().regex(/^ak_ntl_prod_[A-Za-z0-9_-]{1,512}$/),
  agentId: agentIdSchema,
  platformPartyId: partyIdSchema,
  walletId: walletIdSchema,
});
export type NaturalOwnerPilotConfig = z.infer<typeof configuration>;

/** Explicit local pilot configuration; never reads process.env or discovers a wallet. */
export function readOwnerPilotConfig(env: NaturalEnvironment): NaturalOwnerPilotConfig {
  const parsed = configuration.safeParse({
    environment: 'production',
    apiKey: env.NATURAL_PRODUCTION_AGENT_KEY,
    agentId: env.NATURAL_PRODUCTION_AGENT_ID,
    platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
    walletId: env.NATURAL_OWNER_PILOT_WALLET_ID,
  });
  if (!parsed.success) throw new NaturalProviderError('configuration', 'not_submitted');
  return parsed.data;
}

export interface OwnerPilotWallet {
  partyId: string;
  partyType: 'PERSON';
  status: 'ACTIVE';
  handle: string | null;
  primaryPhone: string | null;
  walletId: string;
  availableMinor: number;
  currency: 'USD';
}
const sendInput = z.strictObject({
  walletId: walletIdSchema,
  recipientHandle: handle,
  amountMinor: z.number().int().min(1).max(100),
  operationId: operationSchema.shape.instanceId,
  idempotencyKey: operationSchema.shape.idempotencyKey,
});
export type OwnerPilotSendInput = z.infer<typeof sendInput>;

const ownPartyResponse = z.object({
  data: z.object({
    type: z.literal('party'),
    id: partyIdSchema,
    attributes: z.object({
      partyType: z.enum(['PERSON', 'ORG']),
      status: z.enum(['PROVISIONAL', 'ACTIVE', 'SUSPENDED', 'INACTIVE']),
      handle: handle.nullable(),
      primaryPhone: z
        .string()
        .regex(/^\+[1-9]\d{1,14}$/)
        .nullable(),
    }),
  }),
});
const nullableRelation = <T extends string>(type: T, id: z.ZodString) =>
  z.object({ data: z.object({ type: z.literal(type), id }).nullable() });
const paymentResource = z.object({
  type: z.literal('payment'),
  id: paymentIdSchema,
  attributes: z.object({
    amount: centsSchema,
    currency: z.literal('USD'),
    status: z.enum([
      'CREATED',
      'PROCESSING',
      'PENDING_CLAIM',
      'IN_REVIEW',
      'COMPLETED',
      'FAILED',
      'RETURNED',
      'APPROVAL_DENIED',
      'CANCELED',
    ]),
    tags: z.record(z.string(), z.string()),
    fee: z
      .object({
        amount: centsSchema,
        currency: z.literal('USD'),
        payer: z.literal('sender'),
        applied: z.literal('on_top'),
      })
      .nullable(),
  }),
  relationships: z.object({
    sender: nullableRelation('party', partyIdSchema),
    senderAgent: nullableRelation('agent', agentIdSchema),
    recipient: nullableRelation('party', partyIdSchema),
    recipientAgent: nullableRelation('agent', agentIdSchema),
    paymentRequest: nullableRelation('paymentRequest', paymentRequestIdSchema),
  }),
});
const paymentResponse = z.object({ data: paymentResource });
const paymentPage = z.object({
  data: z.array(paymentResource).max(100),
  meta: z.object({ pagination: paginationSchema }),
});
type PaymentResource = z.infer<typeof paymentResource>;
export interface OwnerPilotPayment {
  id: string;
  status: PaymentResource['attributes']['status'];
  amountMinor: number;
  currency: 'USD';
  senderPartyId: string;
  senderAgentId: string;
  recipientPartyId: string | null;
  recipientAgentId: string | null;
  tags: Record<string, string>;
  feeMinor: number | null;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NaturalProviderError('invalid_input', 'not_submitted');
  return parsed.data;
}
function bound(value: boolean, mutation = false): asserts value {
  if (!value)
    throw new NaturalProviderError('binding_mismatch', mutation ? 'unknown' : 'not_submitted');
}

/** Local owner-only pilot. Existing issuance evidence must bind this key to the configured
 * agent. The caller must persist consent and operation identity before send, and enforce
 * the single-payment limit durably. No automatic retries or provider setup occurs here.
 */
export class NaturalOwnerPilotClient {
  readonly #config: NaturalOwnerPilotConfig;
  readonly #transport: OwnerPilotTransport;
  constructor(config: NaturalOwnerPilotConfig, options: NaturalClientOptions = {}) {
    const parsed = configuration.safeParse(config);
    if (!parsed.success) throw new NaturalProviderError('configuration', 'not_submitted');
    this.#config = parsed.data;
    this.#transport = new OwnerPilotTransport(parsed.data.apiKey, parsed.data.walletId, options);
  }

  async getOwnerWallet(): Promise<OwnerPilotWallet> {
    const party = (await this.#transport.request('/parties/me', ownPartyResponse)).data;
    bound(
      party.id === this.#config.platformPartyId &&
        party.attributes.partyType === 'PERSON' &&
        party.attributes.status === 'ACTIVE',
    );
    const wallet = await this.#transport.request(
      `/wallets/${this.#config.walletId}`,
      walletResponse,
    );
    bound(
      wallet.id === this.#config.walletId &&
        wallet.partyId === party.id &&
        wallet.status === 'active' &&
        wallet.walletType === 'standard' &&
        wallet.balance !== null,
    );
    return {
      partyId: party.id,
      partyType: 'PERSON',
      status: 'ACTIVE',
      handle: party.attributes.handle,
      primaryPhone: party.attributes.primaryPhone,
      walletId: wallet.id,
      availableMinor: wallet.balance!.available,
      currency: wallet.balance!.currency,
    };
  }

  #payment(payment: PaymentResource, mutation = false): OwnerPilotPayment {
    const attributes = payment.attributes;
    const relations = payment.relationships;
    bound(
      relations.sender.data?.id === this.#config.platformPartyId &&
        relations.senderAgent.data?.id === this.#config.agentId &&
        relations.recipient.data?.id !== this.#config.platformPartyId &&
        relations.paymentRequest.data === null &&
        attributes.amount <= 100 &&
        attributes.tags.tallie_owner_pilot === 'v1' &&
        operationSchema.shape.instanceId.safeParse(attributes.tags.app_operation_id).success &&
        handle.safeParse(attributes.tags.recipient_handle).success,
      mutation,
    );
    return {
      id: payment.id,
      status: attributes.status,
      amountMinor: attributes.amount,
      currency: attributes.currency,
      senderPartyId: relations.sender.data!.id,
      senderAgentId: relations.senderAgent.data!.id,
      recipientPartyId: relations.recipient.data?.id ?? null,
      recipientAgentId: relations.recipientAgent.data?.id ?? null,
      tags: attributes.tags,
      feeMinor: attributes.fee?.amount ?? null,
    };
  }

  async send(value: OwnerPilotSendInput): Promise<OwnerPilotPayment> {
    const data = parse(sendInput, value);
    bound(data.walletId === this.#config.walletId);
    const wallet = await this.getOwnerWallet();
    bound(
      wallet.availableMinor >= data.amountMinor &&
        wallet.handle?.toLowerCase() !== data.recipientHandle.toLowerCase(),
    );
    const response = await this.#transport.request('/payments', paymentResponse, {
      operation: { instanceId: data.operationId, idempotencyKey: data.idempotencyKey },
      attributes: {
        walletId: data.walletId,
        amount: data.amountMinor,
        currency: 'USD',
        counterparty: { type: 'handle', value: data.recipientHandle },
        description: 'Tallie personal payment test',
        tags: {
          app_operation_id: data.operationId,
          tallie_owner_pilot: 'v1',
          recipient_handle: data.recipientHandle,
        },
      },
    });
    const payment = this.#payment(response.data, true);
    bound(
      payment.amountMinor === data.amountMinor &&
        payment.tags.app_operation_id === data.operationId &&
        payment.tags.recipient_handle === data.recipientHandle,
      true,
    );
    return payment;
  }

  async getPayment(paymentId: string): Promise<OwnerPilotPayment> {
    const id = parse(paymentIdSchema, paymentId);
    const response = await this.#transport.request(`/payments/${id}`, paymentResponse);
    bound(response.data.id === id);
    return this.#payment(response.data);
  }

  /** Scan at most ten pages. Even a found match needs a complete, unambiguous inventory. */
  async findPayment(operationId: string): Promise<OwnerPilotPayment | null> {
    const operation = parse(operationSchema.shape.instanceId, operationId);
    let cursor: string | null = null;
    let match: PaymentResource | null = null;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor !== null) params.set('cursor', cursor);
      const response = await this.#transport.request(`/payments?${params}`, paymentPage);
      for (const payment of response.data) {
        if (ids.has(payment.id))
          throw new NaturalProviderError('invalid_response', 'not_submitted');
        ids.add(payment.id);
        bound(payment.relationships.sender.data?.id === this.#config.platformPartyId);
        if (payment.attributes.tags.app_operation_id === operation) {
          if (match) throw new NaturalProviderError('invalid_response', 'not_submitted');
          match = payment;
        }
      }
      const pagination = response.meta.pagination;
      if (!pagination.hasMore) return match === null ? null : this.#payment(match);
      cursor = pagination.nextCursor;
      if (cursor === null || cursor.length > 1024 || cursors.has(cursor))
        throw new NaturalProviderError('invalid_response', 'not_submitted');
      cursors.add(cursor);
    }
    throw new NaturalProviderError('invalid_response', 'not_submitted');
  }
}
