import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NaturalProviderError,
  type NaturalSandboxInvitation,
  type NaturalInvitation,
  type NaturalWalletPage,
} from '@tallie/natural';
import { createSandboxGateway } from './gateway';
import {
  readSandboxPaymentsConfiguration,
  sandboxPaymentsAvailable,
  SANDBOX_PERMISSIONS,
} from './configuration';

const platformId = `pty_${'1'.repeat(32)}`;
const customerId = `pty_${'2'.repeat(32)}`;
const agentId = `agt_${'3'.repeat(32)}`;
const env = {
  APP_MODE: 'beta',
  NATURAL_SANDBOX_ENABLED: 'true',
  NATURAL_ENVIRONMENT: 'sandbox',
  NATURAL_API_KEY: 'sk_ntl_sandbox_synthetic_only',
  NATURAL_AGENT_KEY: 'ak_ntl_sandbox_synthetic_only',
  NATURAL_AGENT_ID: agentId,
  NATURAL_PLATFORM_PARTY_ID: platformId,
};
const invitation: NaturalInvitation = {
  id: `adi_${'4'.repeat(32)}`,
  agentId,
  customerPartyId: null,
  status: 'PENDING',
  effectiveStatus: 'PENDING',
  permissions: [...SANDBOX_PERMISSIONS],
};
const fixture = () => {
  const party = { id: platformId, partyType: 'ORG' as const, status: 'ACTIVE' as const };
  const provisioning = {
    getOwnParty: vi.fn(async () => party),
    getAgent: vi.fn(async () => ({ id: agentId, partyId: platformId, status: 'ACTIVE' as const })),
    createSandboxInvitation: vi.fn(async (): Promise<NaturalSandboxInvitation> => ({
      customerPartyId: customerId,
      invitations: [{ ...invitation }],
    })),
    acceptSandboxInvitation: vi.fn(async () => ({
      ...invitation,
      status: 'ACCEPTED' as const,
      effectiveStatus: 'ACCEPTED' as const,
      customerPartyId: customerId,
    })),
  };
  const agent = {
    getOwnParty: vi.fn(async () => party),
    getCustomer: vi.fn(async () => ({
      id: customerId,
      delegation: {
        id: 'delegation',
        status: 'ACTIVE' as const,
        permissions: [...SANDBOX_PERMISSIONS],
      },
      agents: [{ id: agentId, status: 'ACTIVE', permissions: [...SANDBOX_PERMISSIONS] }],
    })),
    listWallets: vi.fn(async (): Promise<NaturalWalletPage> => ({
      wallets: [
        {
          id: `wal_${'5'.repeat(32)}`,
          partyId: customerId,
          status: 'active',
          walletType: 'standard',
          isDefault: true,
          agentDefault: true,
          displayName: 'Synthetic',
          balance: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    })),
  };
  const gateway = createSandboxGateway(readSandboxPaymentsConfiguration(env)!, {
    provisioning,
    agent,
  });
  return { provisioning, agent, gateway };
};
const input = {
  operationId: 'operation_test',
  idempotencyKey: 'stable_retry_test',
  agentId,
  permissions: [...SANDBOX_PERMISSIONS],
};

afterEach(() => vi.restoreAllMocks());

describe('Natural web configuration', () => {
  it('requires explicit opt-in, literal sandbox and complete role-specific credentials', () => {
    expect(sandboxPaymentsAvailable({})).toBe(false);
    expect(
      readSandboxPaymentsConfiguration({ ...env, NATURAL_SANDBOX_ENABLED: 'false' }),
    ).toBeNull();
    expect(sandboxPaymentsAvailable(env)).toBe(true);
    for (const patch of [
      { NATURAL_ENVIRONMENT: '' },
      { NATURAL_ENVIRONMENT: 'production' },
      { APP_MODE: 'production' },
      { NATURAL_AGENT_KEY: '' },
      { NATURAL_AGENT_KEY: 'ak_ntl_prod_secret' },
      { NATURAL_API_KEY: 'sk_ntl_prod_secret' },
      { NATURAL_PLATFORM_PARTY_ID: '' },
      { NATURAL_AGENT_ID: '' },
      { NATURAL_API_BASE_URL: 'https://api.natural.com' },
      { NATURAL_API_BASE_URL: 'https://untrusted.invalid' },
      { NATURAL_PROVISIONING_API_KEY: 'sk_ntl_sandbox_different' },
    ])
      expect(sandboxPaymentsAvailable({ ...env, ...patch })).toBe(false);
  });
});

describe('Natural sandbox web gateway', () => {
  it('verifies both credential parties and agent ownership before mutation, retaining operation IDs', async () => {
    const f = fixture();
    await f.gateway.createInvitation(input);
    await f.gateway.acceptInvitation({
      ...input,
      invitationId: invitation.id,
      customerPartyId: customerId,
    });
    expect(f.provisioning.getOwnParty).toHaveBeenCalledOnce();
    expect(f.agent.getOwnParty).toHaveBeenCalledOnce();
    expect(f.provisioning.createSandboxInvitation).toHaveBeenCalledExactlyOnceWith({
      agentId,
      permissions: [...SANDBOX_PERMISSIONS],
      operation: { instanceId: input.operationId, idempotencyKey: input.idempotencyKey },
    });
    expect(f.provisioning.acceptSandboxInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPartyId: customerId,
        invitationId: invitation.id,
      }),
    );
  });

  it('blocks mismatched platform/agent configuration before creating customers', async () => {
    for (const wrong of ['party', 'agent'] as const) {
      const f = fixture();
      if (wrong === 'party')
        f.agent.getOwnParty.mockResolvedValue({
          id: customerId,
          status: 'ACTIVE',
          partyType: 'ORG',
        });
      else
        f.provisioning.getAgent.mockResolvedValue({
          id: agentId,
          partyId: customerId,
          status: 'ACTIVE',
        });
      await expect(f.gateway.createInvitation(input)).rejects.toMatchObject({
        outcome: 'rejected',
      });
      expect(f.provisioning.createSandboxInvitation).not.toHaveBeenCalled();
    }
  });

  it('does not permit permission expansion or platform-party acceptance', async () => {
    const f = fixture();
    await expect(
      f.gateway.createInvitation({ ...input, permissions: ['payments.create'] }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    await expect(
      f.gateway.acceptInvitation({
        ...input,
        invitationId: invitation.id,
        customerPartyId: platformId,
      }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(f.provisioning.createSandboxInvitation).not.toHaveBeenCalled();
    expect(f.provisioning.acceptSandboxInvitation).not.toHaveBeenCalled();
  });

  it('keeps ambiguous mutation errors unknown and never exposes provider payloads or retries automatically', async () => {
    const f = fixture();
    f.provisioning.createSandboxInvitation.mockRejectedValue(
      new NaturalProviderError('http', 'unknown', 409),
    );
    await expect(f.gateway.createInvitation(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.provisioning.createSandboxInvitation).toHaveBeenCalledOnce();
    f.provisioning.createSandboxInvitation.mockRejectedValue(
      new Error('secret account and routing details'),
    );
    await expect(f.gateway.createInvitation(input)).rejects.toThrow(
      'The sandbox provider action could not be completed.',
    );
  });

  it('treats revoked provider authorization as blocked and preserves null balances', async () => {
    const f = fixture();
    const wallets = await f.gateway.listWallets(customerId);
    expect(wallets[0]!.balance).toBeNull();
    expect(wallets[0]).not.toHaveProperty('displayName');
    f.agent.getCustomer.mockRejectedValue(new NaturalProviderError('http', 'not_submitted', 403));
    await expect(f.gateway.getCustomer(customerId)).rejects.toMatchObject({ outcome: 'rejected' });
  });

  it('refuses partial wallet lists because the current wallet API documents no cursor input', async () => {
    const f = fixture();
    f.agent.listWallets.mockResolvedValue({ wallets: [], hasMore: true, nextCursor: 'more' });
    await expect(f.gateway.listWallets(customerId)).rejects.toMatchObject({ outcome: 'rejected' });
  });
});
