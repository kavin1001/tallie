import { z } from 'zod';
import { agentIdSchema, externalAccountIdSchema, partyIdSchema, partyResponse } from './contracts';
import type { NaturalEnvironment } from './config';
import { NaturalProviderError } from './errors';
import { ProductionBankTransport, type NaturalClientOptions } from './transport';

const configuration = z.strictObject({
  environment: z.literal('production'),
  apiKey: z.string().regex(/^ak_ntl_prod_[A-Za-z0-9_-]{1,512}$/),
  agentId: agentIdSchema,
  platformPartyId: partyIdSchema,
});
export type NaturalProductionBankConfig = z.infer<typeof configuration>;
export function readProductionBankConfig(env: NaturalEnvironment): NaturalProductionBankConfig {
  const result = configuration.safeParse({
    environment: 'production',
    apiKey: env.NATURAL_PRODUCTION_AGENT_KEY,
    agentId: env.NATURAL_PRODUCTION_AGENT_ID,
    platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
  });
  if (!result.success) throw new NaturalProviderError('configuration', 'not_submitted');
  return result.data;
}

const cursorSchema = z.string().min(1).max(1024);
const listInput = z.strictObject({
  customerPartyId: partyIdSchema,
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const detailInput = z.strictObject({
  customerPartyId: partyIdSchema,
  externalAccountId: externalAccountIdSchema,
});
export type ListProductionBanksInput = z.input<typeof listInput>;
export type GetProductionBankInput = z.infer<typeof detailInput>;

const bankResource = z.object({
  type: z.literal('externalAccount'),
  id: externalAccountIdSchema,
  attributes: z.object({
    // Never expose a provider accidentally returning a full account number here.
    lastFour: z.string().regex(/^\d{4}$/),
    bankName: z.string().trim().min(1).max(160).nullable(),
    accountType: z.enum(['checking', 'savings', 'unknown']).nullable(),
    status: z.enum(['pending', 'new', 'active', 'disabled', 'deleted', 'unknown']),
    connectionStatus: z.enum(['active', 'login_required', 'disconnected']),
    availableMethods: z.array(z.enum(['standard', 'instant'])).max(2),
  }),
  relationships: z.object({
    party: z.object({ data: z.object({ type: z.literal('party'), id: partyIdSchema }) }),
  }),
});
const pageResponse = z.object({
  data: z.array(bankResource).max(100),
  meta: z.object({
    pagination: z
      .object({ hasMore: z.boolean(), nextCursor: cursorSchema.nullable() })
      .refine((page) => page.hasMore === (page.nextCursor !== null)),
  }),
});
const detailResponse = z.object({ data: bankResource });

/** Display-only snapshot. `connected` is not transfer authorization, verification
 * evidence, sufficient funds, instant-rail eligibility, or a guarantee of settlement.
 * The public bank resource exposes no separate verified flag.
 */
export interface NaturalProductionBank {
  readonly id: string;
  readonly bankName: string | null;
  readonly lastFour: string;
  readonly accountType: 'checking' | 'savings' | 'unknown' | null;
  readonly readiness: 'connected' | 'relink_required' | 'pending' | 'unavailable';
  readonly withdrawalMethods: readonly ('standard' | 'instant')[];
}
export interface NaturalProductionBankPage {
  readonly banks: readonly NaturalProductionBank[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
function bound(condition: boolean): asserts condition {
  if (!condition) throw new NaturalProviderError('binding_mismatch', 'not_submitted');
}
function toDisplayBank(resource: z.infer<typeof bankResource>): NaturalProductionBank {
  const attributes = resource.attributes;
  const readiness =
    attributes.status === 'active'
      ? attributes.connectionStatus === 'active'
        ? 'connected'
        : 'relink_required'
      : ['pending', 'new'].includes(attributes.status)
        ? 'pending'
        : 'unavailable';
  return {
    id: resource.id,
    bankName: attributes.bankName,
    lastFour: attributes.lastFour,
    accountType: attributes.accountType,
    readiness,
    withdrawalMethods: readiness === 'connected' ? [...new Set(attributes.availableMethods)] : [],
  };
}

/** Caller must resolve the customer from an authenticated Tallie account's accepted
 * connection. These reads require wallets.read and do not collect bank credentials.
 * The agent key's issuance evidence must establish its exact agent association.
 */
export class NaturalProductionBankClient {
  readonly #config: NaturalProductionBankConfig;
  readonly #transport: ProductionBankTransport;
  constructor(config: NaturalProductionBankConfig, options: NaturalClientOptions = {}) {
    const result = configuration.safeParse(config);
    if (!result.success) throw new NaturalProviderError('configuration', 'not_submitted');
    this.#config = result.data;
    this.#transport = new ProductionBankTransport(result.data.apiKey, options);
  }

  async #verifyPlatform(customerPartyId: string): Promise<void> {
    if (customerPartyId === this.#config.platformPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const party = await this.#transport.request('/parties/me', partyResponse);
    bound(party.id === this.#config.platformPartyId && party.status === 'ACTIVE');
  }

  async listLinkedBanks(value: ListProductionBanksInput): Promise<NaturalProductionBankPage> {
    const result = listInput.safeParse(value);
    if (!result.success) throw new NaturalProviderError('invalid_input', 'not_submitted');
    const input = result.data;
    await this.#verifyPlatform(input.customerPartyId);
    const query = new URLSearchParams({
      customerPartyId: input.customerPartyId,
      limit: String(input.limit),
    });
    if (input.cursor) query.set('cursor', input.cursor);
    const page = await this.#transport.request(`/external-accounts?${query}`, pageResponse);
    bound(
      page.data.every((bank) => bank.relationships.party.data.id === input.customerPartyId) &&
        new Set(page.data.map((bank) => bank.id)).size === page.data.length,
    );
    if (
      page.data.length > input.limit ||
      (page.meta.pagination.hasMore && page.meta.pagination.nextCursor === input.cursor)
    )
      throw new NaturalProviderError('invalid_response', 'not_submitted');
    return { banks: page.data.map(toDisplayBank), ...page.meta.pagination };
  }

  async getLinkedBank(value: GetProductionBankInput): Promise<NaturalProductionBank> {
    const result = detailInput.safeParse(value);
    if (!result.success) throw new NaturalProviderError('invalid_input', 'not_submitted');
    const input = result.data;
    await this.#verifyPlatform(input.customerPartyId);
    const response = await this.#transport.request(
      `/external-accounts/${input.externalAccountId}?customerPartyId=${input.customerPartyId}`,
      detailResponse,
    );
    bound(
      response.data.id === input.externalAccountId &&
        response.data.relationships.party.data.id === input.customerPartyId,
    );
    return toDisplayBank(response.data);
  }
}
