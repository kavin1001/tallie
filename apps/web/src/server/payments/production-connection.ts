import { identityDatabase, identityVault } from '@tallie/identity';
import {
  NaturalProductionConnectClient,
  NaturalProductionWalletClient,
  readProductionConnectConfig,
  readProductionWalletConfig,
  type NaturalProductionConnectConfig,
  type NaturalProductionWalletConfig,
} from '@tallie/natural';
import {
  ProductionConnectionService,
  type ProductionConnectionConfiguration,
  type ProductionConnectionGateway,
  type PaymentDatabase,
} from '@tallie/payments';
import type { Kysely } from 'kysely';
import { AppError } from '../errors';
import { naturalWebhookConfiguration } from './webhook';

type Environment = Readonly<Record<string, string | undefined>>;
export interface ProductionConnectionWebConfiguration {
  connection: ProductionConnectionConfiguration;
  connect: NaturalProductionConnectConfig;
  wallets: NaturalProductionWalletConfig;
}
/** Configuration only: no provider call, invitation, or production payment. */
export function readProductionConnectionConfiguration(
  env: Environment = process.env,
): ProductionConnectionWebConfiguration | null {
  if (env.NATURAL_PRODUCTION_CONNECT_ENABLED !== 'true') return null;
  try {
    if (
      env.APP_MODE !== 'beta' ||
      env.APP_PREVIEW_MODE === 'true' ||
      env.IDENTITY_PHONE_DEMO_ENABLED === 'true'
    )
      throw new Error('Production account setup requires the beta account app.');
    const rawLimit = env.NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR ?? '';
    if (!/^[1-9][0-9]{0,4}$/.test(rawLimit) || Number(rawLimit) > 10000)
      throw new Error('Explicit activation limit required.');
    const connect = readProductionConnectConfig(env);
    const wallets = readProductionWalletConfig(env);
    naturalWebhookConfiguration('production', env);
    return {
      connect,
      wallets,
      connection: {
        enabled: true,
        environment: 'production',
        platformPartyId: connect.platformPartyId,
        agentId: connect.agentId,
        perTransactionLimitMinor: Number(rawLimit),
      },
    };
  } catch {
    throw new AppError(
      'CONNECTION_UNAVAILABLE',
      'Payment account setup is not available yet.',
      503,
    );
  }
}
export function createProductionConnectionGateway(
  configuration: Pick<ProductionConnectionWebConfiguration, 'connect' | 'wallets'>,
  clients = {
    connect: new NaturalProductionConnectClient(configuration.connect),
    wallets: new NaturalProductionWalletClient(configuration.wallets),
  },
): ProductionConnectionGateway {
  return {
    createInvitation: (input) => clients.connect.createInvitation(input),
    verifyAcceptedConnection: (input) => clients.connect.verifyAcceptedConnection(input),
    getReceivingWallet: (partyId) => clients.wallets.getReceivingWallet(partyId),
  };
}
export function productionConnectionService(): ProductionConnectionService {
  const config = readProductionConnectionConfiguration();
  if (!config)
    throw new AppError(
      'CONNECTION_UNAVAILABLE',
      'Payment account setup is not available yet.',
      503,
    );
  return new ProductionConnectionService(
    identityDatabase() as unknown as Kysely<PaymentDatabase>,
    createProductionConnectionGateway(config),
    identityVault(),
    config.connection,
  );
}

export function productionConnectionAvailable(env: Environment = process.env): boolean {
  try {
    return readProductionConnectionConfiguration(env) !== null;
  } catch {
    return false;
  }
}
