import {
  NaturalAgentClient,
  readAgentConfig,
  type NaturalAgentConfig,
  type NaturalEnvironment,
} from '@tallie/natural';
import {
  SandboxPaymentReconciliationService,
  type PaymentDatabase,
  type SandboxReconciliationGateway,
} from '@tallie/payments';
import type { Kysely } from 'kysely';

/** Workers require no provisioning key and never receive send/fund capabilities. */
export function readPaymentWorkerConfiguration(
  env: NaturalEnvironment = process.env,
): NaturalAgentConfig | null {
  if (env.NATURAL_RECONCILIATION_ENABLED !== 'true') return null;
  if (!['demo', 'beta'].includes(env.APP_MODE ?? '') || env.NATURAL_ENVIRONMENT !== 'sandbox')
    throw new Error('Payment reconciliation requires an explicit sandbox configuration.');
  return readAgentConfig(env);
}

type ReadClient = Pick<NaturalAgentClient, 'getDirectPayment' | 'listPayments' | 'getDeposit'>;

export function createPaymentReadGateway(
  config: NaturalAgentConfig,
  client: ReadClient = new NaturalAgentClient(config),
): SandboxReconciliationGateway {
  return {
    getPayment: (input) =>
      client.getDirectPayment({
        customerPartyId: input.senderPartyId,
        paymentId: input.paymentId,
        expected: {
          senderPartyId: input.senderPartyId,
          recipientPartyId: input.recipientPartyId,
          amount: input.amount,
          currency: 'USD',
        },
      }),
    listPayments: (input) =>
      client.listPayments({
        customerPartyId: input.senderPartyId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    getDeposit: (input) => client.getDeposit(input),
  };
}

export function configuredPaymentReconciliation(
  db: Kysely<PaymentDatabase>,
  env: NaturalEnvironment = process.env,
) {
  const config = readPaymentWorkerConfiguration(env);
  return config
    ? new SandboxPaymentReconciliationService(
        db,
        createPaymentReadGateway(config),
        config.agentId,
        config.platformPartyId,
      )
    : null;
}
