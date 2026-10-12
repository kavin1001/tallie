import { z } from 'zod';
import {
  agentIdSchema,
  agentResponse,
  invitationIdSchema,
  operationSchema,
  partyIdSchema,
  partyResponse,
} from './contracts';
import type { NaturalEnvironment } from './config';
import { NaturalProviderError } from './errors';
import { ProductionConnectTransport, type NaturalClientOptions } from './transport';

export const PRODUCTION_CONNECT_PERMISSIONS = [
  'party.read',
  'wallets.read',
  'wallets.balance',
  'payments.read',
  'payments.create',
] as const;
const permissions = z.array(z.string()).min(1).max(64);
const relation = <T extends string>(type: T, id: z.ZodString) =>
  z.object({ data: z.object({ type: z.literal(type), id }) });
const eventId = z.string().regex(/^evt_[0-9a-f]{32}$/);
const cents = z.number().int().min(1).max(10_000);
const opaqueState = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const phone = z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/);
const httpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
});
const configuration = z.strictObject({
  environment: z.literal('production'),
  apiKey: z.string().regex(/^sk_ntl_prod_[A-Za-z0-9_-]{1,512}$/),
  agentId: agentIdSchema,
  platformPartyId: partyIdSchema,
  appOrigin: httpsOrigin,
});
export type NaturalProductionConnectConfig = z.infer<typeof configuration>;

/** Independent names prevent a production key from reaching the sandbox implementation. */
export function readProductionConnectConfig(
  env: NaturalEnvironment,
): NaturalProductionConnectConfig {
  const parsed = configuration.safeParse({
    environment: 'production',
    apiKey: env.NATURAL_PRODUCTION_API_KEY,
    agentId: env.NATURAL_PRODUCTION_AGENT_ID,
    platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
    appOrigin: env.APP_ORIGIN,
  });
  if (!parsed.success) throw new NaturalProviderError('configuration', 'not_submitted');
  return parsed.data;
}

const invitationInput = z.strictObject({
  verifiedPhone: phone,
  returnState: opaqueState,
  perTransactionLimitMinor: cents,
  operation: operationSchema,
});
export type CreateProductionInvitationInput = z.infer<typeof invitationInput>;
const invitationResponse = z.object({
  data: z
    .array(
      z.object({
        type: z.literal('agentDelegationInvitation'),
        id: invitationIdSchema,
        attributes: z.object({
          phone,
          url: z.string().url(),
          permissions,
          limits: z.object({ perTransaction: cents }),
          status: z.literal('PENDING'),
          effectiveStatus: z.literal('PENDING'),
          redirectUrl: z.string().url(),
          expiresAt: z.iso.datetime({ offset: true }),
        }),
        relationships: z.object({
          agent: relation('agent', agentIdSchema),
          customerParty: z.object({ data: z.null() }),
        }),
      }),
    )
    .length(1),
  meta: z.object({
    failedRecipients: z.array(z.unknown()).length(0),
    alreadyConnected: z.array(z.unknown()).length(0),
  }),
});
const acceptedInput = z.strictObject({
  eventId,
  invitationId: invitationIdSchema,
  perTransactionLimitMinor: cents,
});
export type VerifyProductionConnectionInput = z.infer<typeof acceptedInput>;
const acceptedEvent = z.object({
  data: z.object({
    type: z.literal('event'),
    id: eventId,
    attributes: z.object({
      eventType: z.literal('agent_delegation_invitation.accepted'),
      resourceId: invitationIdSchema,
      resourceType: z.literal('agent_delegation_invitation'),
      payload: z.object({
        object: z.object({
          invitationId: invitationIdSchema,
          agentId: agentIdSchema,
          delegateePartyId: partyIdSchema,
          delegatorPartyId: partyIdSchema,
          status: z.literal('accepted'),
          permissions,
          limits: z.object({ perTransactionCents: cents }),
        }),
      }),
    }),
    relationships: z.object({ party: relation('party', partyIdSchema) }),
  }),
});
const customerResponse = z.object({
  data: z.object({
    type: z.literal('customer'),
    id: partyIdSchema,
    attributes: z.object({
      delegation: z.object({
        id: z.string().regex(/^dlg_[0-9a-f]{32}$/),
        status: z.string(),
        permissions,
      }),
      agents: z.array(
        z.object({
          id: agentIdSchema,
          status: z.string(),
          permissions,
          limits: z
            .object({
              perTransaction: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  }),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NaturalProviderError('invalid_input', 'not_submitted');
  return parsed.data;
}
function samePermissions(actual: readonly string[]): boolean {
  return (
    actual.length === PRODUCTION_CONNECT_PERMISSIONS.length &&
    new Set(actual).size === actual.length &&
    PRODUCTION_CONNECT_PERMISSIONS.every((permission) => actual.includes(permission))
  );
}
function bound(value: boolean, mutation = false): asserts value {
  if (!value)
    throw new NaturalProviderError('binding_mismatch', mutation ? 'unknown' : 'not_submitted');
}

/** Hosted activation only: it cannot create payments, accept invitations for customers,
 * collect KYC fields or use simulations. Callers must journal
 * the invitation operation before invoking it, and obtain the phone from the authenticated
 * account. Return state must be random, stored as a hash and bound to account + operation.
 */
export class NaturalProductionConnectClient {
  readonly #config: NaturalProductionConnectConfig;
  readonly #transport: ProductionConnectTransport;
  constructor(config: NaturalProductionConnectConfig, options: NaturalClientOptions = {}) {
    const parsed = configuration.safeParse(config);
    if (!parsed.success) throw new NaturalProviderError('configuration', 'not_submitted');
    this.#config = parsed.data;
    this.#transport = new ProductionConnectTransport(parsed.data.apiKey, options);
  }

  async verifyPlatform(): Promise<void> {
    const ownParty = await this.#transport.request('/parties/me', partyResponse);
    bound(ownParty.id === this.#config.platformPartyId && ownParty.status === 'ACTIVE');
    const agent = await this.#transport.request(`/agents/${this.#config.agentId}`, agentResponse);
    bound(
      agent.id === this.#config.agentId &&
        agent.partyId === ownParty.id &&
        agent.status === 'ACTIVE',
    );
    // This proves agent ownership, not which agent an agent key authenticates as.
  }

  async createInvitation(value: CreateProductionInvitationInput) {
    const data = parse(invitationInput, value);
    await this.verifyPlatform();
    // Fixed path and origin. A redirect is navigation only, never evidence of acceptance.
    const redirectUrl = `${this.#config.appOrigin}/payments/connect/return?state=${data.returnState}`;
    const result = await this.#transport.request('/customers/invitations', invitationResponse, {
      operation: data.operation,
      attributes: {
        recipients: [{ type: 'phone', value: data.verifiedPhone }],
        agents: [
          {
            agentId: this.#config.agentId,
            permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
            limits: { perTransaction: data.perTransactionLimitMinor },
          },
        ],
        redirectUrl,
      },
    });
    const invitation = result.data[0]!;
    const attributes = invitation.attributes;
    const url = new URL(attributes.url);
    bound(
      attributes.phone === data.verifiedPhone &&
        invitation.relationships.agent.data.id === this.#config.agentId &&
        samePermissions(attributes.permissions) &&
        attributes.limits.perTransaction === data.perTransactionLimitMinor &&
        attributes.redirectUrl === redirectUrl &&
        url.origin === 'https://www.natural.com' &&
        !url.username &&
        !url.password &&
        url.pathname === `/connect/${invitation.id}` &&
        !url.search &&
        !url.hash,
      true,
    );
    return { invitationId: invitation.id, url: attributes.url, expiresAt: attributes.expiresAt };
  }

  async verifyAcceptedConnection(value: VerifyProductionConnectionInput) {
    const data = parse(acceptedInput, value);
    await this.verifyPlatform();
    const canonical = await this.#transport.request(`/events/${data.eventId}`, acceptedEvent);
    const event = canonical.data;
    const accepted = event.attributes.payload.object;
    // This unscoped platform-key read returns an event owned by the platform.
    // Its party relationship is not the webhook's sourcePartyId (the customer).
    bound(
      event.id === data.eventId &&
        event.attributes.resourceId === data.invitationId &&
        accepted.invitationId === data.invitationId &&
        accepted.agentId === this.#config.agentId &&
        accepted.delegateePartyId === this.#config.platformPartyId &&
        accepted.delegatorPartyId !== this.#config.platformPartyId &&
        event.relationships.party.data.id === this.#config.platformPartyId &&
        samePermissions(accepted.permissions) &&
        accepted.limits.perTransactionCents <= data.perTransactionLimitMinor,
    );
    const customer = (
      await this.#transport.request(`/customers/${accepted.delegatorPartyId}`, customerResponse)
    ).data;
    const matchingAgents = customer.attributes.agents.filter(
      (agent) => agent.id === this.#config.agentId,
    );
    const agent = matchingAgents[0];
    bound(
      customer.id === accepted.delegatorPartyId &&
        customer.attributes.delegation.status === 'ACTIVE' &&
        PRODUCTION_CONNECT_PERMISSIONS.every((permission) =>
          customer.attributes.delegation.permissions.includes(permission),
        ) &&
        matchingAgents.length === 1 &&
        agent?.status === 'ACTIVE' &&
        samePermissions(agent.permissions) &&
        agent.limits !== null &&
        agent.limits.perTransaction !== null &&
        agent.limits.perTransaction <= accepted.limits.perTransactionCents,
    );
    return {
      customerPartyId: customer.id,
      delegationId: customer.attributes.delegation.id,
      agentId: this.#config.agentId,
      perTransactionLimitMinor: agent.limits!.perTransaction,
      invitationAccepted: true as const,
      moneyMovementEnabled: false as const,
    };
  }
}
