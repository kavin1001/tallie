import {
  NaturalProductionConnectClient,
  NaturalProductionWalletClient,
  readProductionConnectConfig,
  readProductionWalletConfig,
  type NaturalEnvironment,
  type NaturalProductionConnectConfig,
  type NaturalProductionWalletConfig,
} from '@tallie/natural';
import {
  ProductionConnectionError,
  ProductionConnectionService,
  type ProductionConnectionConfiguration,
  type ProductionConnectionGateway,
  type PaymentDatabase,
} from '@tallie/payments';
import type { Kysely } from 'kysely';

export interface ProductionPaymentWorkerConfiguration {
  connect: NaturalProductionConnectConfig;
  wallets: NaturalProductionWalletConfig;
  connection: ProductionConnectionConfiguration;
}
/** Read-only activation reconciliation has no signing secret or field-encryption key. */
export function readProductionPaymentWorkerConfiguration(
  env: NaturalEnvironment = process.env,
): ProductionPaymentWorkerConfiguration | null {
  if (env.NATURAL_PRODUCTION_CONNECT_ENABLED !== 'true') return null;
  if (
    env.APP_MODE !== 'beta' ||
    env.APP_PREVIEW_MODE === 'true' ||
    env.IDENTITY_PHONE_DEMO_ENABLED === 'true' ||
    env.NATURAL_PRODUCTION_WEBHOOK_ENABLED !== 'true'
  )
    throw new Error(
      'Production activation processing requires explicit non-preview configuration.',
    );
  const limit = env.NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR ?? '';
  if (!/^[1-9][0-9]{0,4}$/.test(limit) || Number(limit) > 10000)
    throw new Error('Production activation requires an explicit bounded delegation limit.');
  const connect = readProductionConnectConfig(env);
  const wallets = readProductionWalletConfig(env);
  return {
    connect,
    wallets,
    connection: {
      enabled: true,
      environment: 'production',
      platformPartyId: connect.platformPartyId,
      agentId: connect.agentId,
      perTransactionLimitMinor: Number(limit),
    },
  };
}

export function createProductionConnectionReadGateway(
  config: Pick<ProductionPaymentWorkerConfiguration, 'connect' | 'wallets'>,
  clients: {
    connect: Pick<NaturalProductionConnectClient, 'verifyAcceptedConnection'>;
    wallets: Pick<NaturalProductionWalletClient, 'getReceivingWallet'>;
  } = {
    connect: new NaturalProductionConnectClient(config.connect),
    wallets: new NaturalProductionWalletClient(config.wallets),
  },
): ProductionConnectionGateway {
  return {
    createInvitation: async () => {
      throw new ProductionConnectionError('WORKER_MUTATION_DISABLED', 503);
    },
    verifyAcceptedConnection: (input) => clients.connect.verifyAcceptedConnection(input),
    getReceivingWallet: (partyId) => clients.wallets.getReceivingWallet(partyId),
  };
}
export function configuredProductionConnections(
  db: Kysely<PaymentDatabase>,
  env: NaturalEnvironment = process.env,
): ProductionConnectionService | null {
  const config = readProductionPaymentWorkerConfiguration(env);
  return config
    ? new ProductionConnectionService(
        db,
        createProductionConnectionReadGateway(config),
        null,
        config.connection,
      )
    : null;
}
