import {
  NaturalAgentClient,
  NaturalProviderError,
  NaturalProvisioningClient,
} from '@tallie/natural';
import { SandboxGatewayError, type SandboxOnboardingGateway } from '@tallie/payments';
import {
  SANDBOX_PERMISSIONS,
  SANDBOX_SEND_PERMISSIONS,
  type SandboxPaymentsConfiguration,
} from './configuration';

type Provisioning = Pick<
  NaturalProvisioningClient,
  'getOwnParty' | 'getAgent' | 'createSandboxInvitation' | 'acceptSandboxInvitation'
>;
type Agent = Pick<NaturalAgentClient, 'getOwnParty' | 'getCustomer' | 'listWallets'>;

/** Provider credentials and IDs remain behind this server boundary. */
export function createSandboxGateway(
  config: SandboxPaymentsConfiguration,
  clients: { provisioning: Provisioning; agent: Agent } = {
    provisioning: new NaturalProvisioningClient(config.provisioning),
    agent: new NaturalAgentClient(config.agent),
  },
  profile: 'read' | 'send' = 'read',
): SandboxOnboardingGateway {
  const permissions = profile === 'send' ? SANDBOX_SEND_PERMISSIONS : SANDBOX_PERMISSIONS;
  let checked: Promise<void> | undefined;
  const preflight = () =>
    (checked ??= (async () => {
      const [party, runtimeParty, agent] = await Promise.all([
        clients.provisioning.getOwnParty(),
        clients.agent.getOwnParty(),
        clients.provisioning.getAgent(config.agent.agentId),
      ]);
      if (
        party.id !== config.agent.platformPartyId ||
        runtimeParty.id !== party.id ||
        party.status !== 'ACTIVE' ||
        runtimeParty.status !== 'ACTIVE' ||
        agent.id !== config.agent.agentId ||
        agent.partyId !== party.id ||
        agent.status !== 'ACTIVE'
      )
        throw new SandboxGatewayError('SANDBOX_CONFIGURATION_MISMATCH', 'rejected');
      // This proves party/resource ownership, not the agent key's binding. See the runbook.
    })());

  const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      await preflight();
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

  return {
    createInvitation: (input) =>
      invoke(() => {
        if (
          input.agentId !== config.agent.agentId ||
          input.permissions.length !== permissions.length ||
          !permissions.every((permission) => input.permissions.includes(permission))
        )
          throw new SandboxGatewayError('SANDBOX_CONFIGURATION_MISMATCH', 'rejected');
        return clients.provisioning.createSandboxInvitation({
          agentId: config.agent.agentId,
          permissions: [...permissions],
          operation: { instanceId: input.operationId, idempotencyKey: input.idempotencyKey },
        });
      }),
    acceptInvitation: (input) =>
      invoke(() => {
        if (
          input.agentId !== config.agent.agentId ||
          input.customerPartyId === config.agent.platformPartyId
        )
          throw new SandboxGatewayError('SANDBOX_CONFIGURATION_MISMATCH', 'rejected');
        return clients.provisioning.acceptSandboxInvitation({
          invitationId: input.invitationId,
          customerPartyId: input.customerPartyId,
          agentId: config.agent.agentId,
          operation: { instanceId: input.operationId, idempotencyKey: input.idempotencyKey },
        });
      }),
    getCustomer: (customerPartyId) => invoke(() => clients.agent.getCustomer(customerPartyId)),
    listWallets: (customerPartyId) =>
      invoke(async () => {
        const result = await clients.agent.listWallets(customerPartyId);
        // Natural documents hasMore but no cursor input for wallets. A partial snapshot is unsafe.
        if (result.hasMore)
          throw new SandboxGatewayError('SANDBOX_WALLET_PAGE_INCOMPLETE', 'rejected');
        return result.wallets.map((wallet) => ({
          id: wallet.id,
          partyId: wallet.partyId,
          status: wallet.status,
          walletType: wallet.walletType,
          balance:
            wallet.balance === null
              ? null
              : {
                  currency: wallet.balance.currency,
                  available: String(wallet.balance.available),
                  total: String(wallet.balance.total),
                },
        }));
      }),
  };
}
