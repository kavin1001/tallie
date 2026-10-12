import {
  NaturalAgentClient,
  NaturalProviderError,
  NaturalProvisioningClient,
  type NaturalPayment,
} from '@tallie/natural';
import {
  SandboxGatewayError,
  type SandboxPayment,
  type SandboxSendGateway,
} from '@tallie/payments';
import type { SandboxPaymentsConfiguration } from './configuration';

type Provisioning = Pick<NaturalProvisioningClient, 'fundSandboxCustomer'>;
type Agent = Pick<
  NaturalAgentClient,
  | 'getCustomer'
  | 'getWallet'
  | 'listWallets'
  | 'createDirectWalletPayment'
  | 'getDirectPayment'
  | 'listPayments'
>;

function payment(value: NaturalPayment): SandboxPayment {
  return {
    id: value.id,
    amount: value.amount,
    currency: value.currency,
    status: value.status,
    senderPartyId: value.senderPartyId,
    recipientPartyId: value.recipientPartyId,
    senderAgentId: value.senderAgentId,
    paymentRequestId: value.paymentRequestId,
    tags: value.tags,
  };
}

/** No arbitrary recipient or credential reaches this boundary from the browser. */
export function createSandboxSendGateway(
  config: SandboxPaymentsConfiguration,
  clients: { provisioning: Provisioning; agent: Agent } = {
    provisioning: new NaturalProvisioningClient(config.provisioning),
    agent: new NaturalAgentClient(config.agent),
  },
): SandboxSendGateway {
  const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SandboxGatewayError) throw error;
      const rejected =
        error instanceof NaturalProviderError &&
        (error.outcome === 'rejected' ||
          (error.outcome === 'not_submitted' &&
            (['configuration', 'invalid_input', 'binding_mismatch'].includes(error.reason) ||
              [401, 403, 404].includes(error.status ?? 0))));
      throw new SandboxGatewayError(
        'SANDBOX_PROVIDER_UNAVAILABLE',
        rejected ? 'rejected' : 'unknown',
      );
    }
  };
  const wallet = (value: Awaited<ReturnType<Agent['getWallet']>>) => ({
    id: value.id,
    partyId: value.partyId,
    status: value.status,
    walletType: value.walletType,
    balance: value.balance
      ? {
          currency: value.balance.currency,
          available: String(value.balance.available),
          total: String(value.balance.total),
        }
      : null,
  });
  return {
    getCustomer: (partyId) => invoke(() => clients.agent.getCustomer(partyId)),
    getWallet: (input) => invoke(async () => wallet(await clients.agent.getWallet(input))),
    listWallets: (partyId) =>
      invoke(async () => {
        const page = await clients.agent.listWallets(partyId);
        if (page.hasMore)
          throw new SandboxGatewayError('SANDBOX_WALLET_PAGE_INCOMPLETE', 'rejected');
        return page.wallets.map(wallet);
      }),
    fund: (input) =>
      invoke(async () => {
        // A party key can provision/fund a test customer but cannot read that
        // customer's wallet. Validate its grant and ownership with the agent key.
        const source = await clients.agent.getWallet({
          customerPartyId: input.customerPartyId,
          walletId: input.walletId,
        });
        if (
          source.id !== input.walletId ||
          source.partyId !== input.customerPartyId ||
          source.status !== 'active' ||
          source.walletType !== 'standard'
        )
          throw new SandboxGatewayError('SANDBOX_WALLET_MISMATCH', 'rejected');
        const result = await clients.provisioning.fundSandboxCustomer({
          customerPartyId: input.customerPartyId,
          walletId: input.walletId,
          amount: input.amount,
          currency: 'USD',
          operation: { instanceId: input.operationId, idempotencyKey: input.idempotencyKey },
        });
        return { id: result.id, status: result.status, amount: result.amount, currency: 'USD' };
      }),
    send: (input) =>
      invoke(async () =>
        payment(
          await clients.agent.createDirectWalletPayment({
            customerPartyId: input.senderPartyId,
            walletId: input.walletId,
            recipientPartyId: input.recipientPartyId,
            amount: input.amount,
            currency: 'USD',
            description: input.description,
            operation: { instanceId: input.operationId, idempotencyKey: input.idempotencyKey },
          }),
        ),
      ),
    getPayment: (input) =>
      invoke(async () =>
        payment(
          await clients.agent.getDirectPayment({
            customerPartyId: input.senderPartyId,
            paymentId: input.paymentId,
            expected: {
              senderPartyId: input.senderPartyId,
              recipientPartyId: input.recipientPartyId,
              amount: input.amount,
              currency: 'USD',
            },
          }),
        ),
      ),
    listPayments: (input) =>
      invoke(async () => {
        const page = await clients.agent.listPayments({
          customerPartyId: input.senderPartyId,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return {
          payments: page.payments.map(payment),
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        };
      }),
  };
}
