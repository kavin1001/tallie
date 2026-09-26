import {
  NaturalAgentClient,
  NaturalProviderError,
  NaturalProvisioningClient,
  readAgentConfig,
  readProvisioningConfig,
} from '@tallie/natural';

// Operator-only, read-only probe. Never logs keys, provider bodies or personal information.
async function main() {
  const provisioning = new NaturalProvisioningClient(readProvisioningConfig(process.env));
  const party = await provisioning.getOwnParty();
  const configuredParty = process.env.NATURAL_PLATFORM_PARTY_ID;
  if (configuredParty && party.id !== configuredParty)
    throw new NaturalProviderError('binding_mismatch', 'not_submitted');
  const result = {
    environment: 'sandbox',
    provisioningCredential: 'verified',
    platformPartyId: party.id,
    platformStatus: party.status,
    agentResource: 'not_configured',
    agentCredentialParty: 'not_configured',
    agentCredentialBinding: 'requires_operator_confirmation',
    consumerP2pApproval: 'not_verified_by_this_probe',
    moneyMovementEnabled: false,
  };
  const agentId = process.env.NATURAL_AGENT_ID;
  if (agentId) {
    const agent = await provisioning.getAgent(agentId);
    if (agent.partyId !== party.id || agent.status !== 'ACTIVE')
      throw new NaturalProviderError('binding_mismatch', 'not_submitted');
    result.agentResource = 'verified';
  }
  if (process.env.NATURAL_AGENT_KEY) {
    const client = new NaturalAgentClient(
      readAgentConfig({
        ...process.env,
        NATURAL_PLATFORM_PARTY_ID: party.id,
      }),
    );
    await client.getOwnParty();
    result.agentCredentialParty = 'verified';
  }
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: 'not_verified',
      reason: error instanceof NaturalProviderError ? error.reason : 'unavailable',
      message: 'Check the local sandbox configuration. No customer or payment was created.',
    }),
  );
  process.exitCode = 1;
});
