import { z } from 'zod';
import {
  agentIdSchema,
  partyIdSchema,
  partyResponse,
  walletResponse,
  walletsResponse,
} from './contracts';
import { type NaturalEnvironment } from './config';
import { NaturalProviderError } from './errors';
import { ProductionWalletTransport, type NaturalClientOptions } from './transport';

const configuration = z.strictObject({
  environment: z.literal('production'),
  apiKey: z.string().regex(/^ak_ntl_prod_[A-Za-z0-9_-]{1,512}$/),
  agentId: agentIdSchema,
  platformPartyId: partyIdSchema,
});
export type NaturalProductionWalletConfig = z.infer<typeof configuration>;
export function readProductionWalletConfig(env: NaturalEnvironment): NaturalProductionWalletConfig {
  const result = configuration.safeParse({
    environment: 'production',
    apiKey: env.NATURAL_PRODUCTION_AGENT_KEY,
    agentId: env.NATURAL_PRODUCTION_AGENT_ID,
    platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
  });
  if (!result.success) throw new NaturalProviderError('configuration', 'not_submitted');
  return result.data;
}
function bound(condition: boolean): asserts condition {
  if (!condition) throw new NaturalProviderError('binding_mismatch', 'not_submitted');
}

/** Read-only. Caller must first establish the customer with its exact accepted invitation.
 * Agent-key binding still requires the provider dashboard's issuance evidence; reading
 * the key's party alone does not prove the configured agent ID is the bound agent.
 */
export class NaturalProductionWalletClient {
  readonly #config: NaturalProductionWalletConfig;
  readonly #transport: ProductionWalletTransport;
  constructor(config: NaturalProductionWalletConfig, options: NaturalClientOptions = {}) {
    const result = configuration.safeParse(config);
    if (!result.success) throw new NaturalProviderError('configuration', 'not_submitted');
    this.#config = result.data;
    this.#transport = new ProductionWalletTransport(result.data.apiKey, options);
  }

  async getReceivingWallet(customerPartyId: string) {
    const result = partyIdSchema.safeParse(customerPartyId);
    if (!result.success || result.data === this.#config.platformPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const customer = result.data;
    const party = await this.#transport.request('/parties/me', partyResponse);
    bound(party.id === this.#config.platformPartyId && party.status === 'ACTIVE');
    const page = await this.#transport.request(
      `/wallets?customerPartyId=${customer}`,
      walletsResponse,
    );
    // The published wallet-list contract has hasMore but no cursor/limit input.
    // Do not invent pagination parameters or choose from a partial inventory.
    if (page.hasMore) throw new NaturalProviderError('invalid_response', 'not_submitted');
    const wallets = page.wallets;
    bound(
      wallets.every((wallet) => wallet.partyId === customer) &&
        new Set(wallets.map((wallet) => wallet.id)).size === wallets.length,
    );
    // In production the documented agentDefault field must be present; the
    // customer's own default can differ from the wallet selected at acceptance.
    const defaults = wallets.filter((wallet) => wallet.agentDefault === true);
    bound(defaults.length === 1);
    const selected = defaults[0]!;
    bound(selected.status === 'active' && selected.walletType === 'standard');
    const canonical = await this.#transport.request(
      `/wallets/${selected.id}?customerPartyId=${customer}`,
      walletResponse,
    );
    bound(
      canonical.id === selected.id &&
        canonical.partyId === customer &&
        canonical.status === 'active' &&
        canonical.walletType === 'standard' &&
        canonical.agentDefault === true,
    );
    return {
      id: canonical.id,
      partyId: canonical.partyId,
      status: canonical.status,
      walletType: canonical.walletType,
      isDefault: canonical.isDefault,
      agentDefault: canonical.agentDefault,
      currency: canonical.balance?.currency ?? null,
    };
  }
}
