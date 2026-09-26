/** These are normalized, server-only provider contracts, never browser input. */
export interface SandboxInvitation {
  id: string;
  agentId: string;
  customerPartyId: string | null;
  status: string;
  effectiveStatus: string;
  permissions: string[];
}
export interface SandboxCustomer {
  id: string;
  delegation: { id: string; status: string; permissions: string[] };
  agents: { id: string; status: string; permissions: string[] }[];
}
export interface SandboxWallet {
  id: string;
  partyId: string;
  status: string;
  walletType: string;
  balance: { available: string; total: string; currency: 'USD' } | null;
}
export interface SandboxOnboardingGateway {
  createInvitation(input: {
    operationId: string;
    idempotencyKey: string;
    agentId: string;
    permissions: string[];
  }): Promise<{ customerPartyId: string; invitations: SandboxInvitation[] }>;
  acceptInvitation(input: {
    invitationId: string;
    customerPartyId: string;
    agentId: string;
    operationId: string;
    idempotencyKey: string;
  }): Promise<SandboxInvitation>;
  getCustomer(customerPartyId: string): Promise<SandboxCustomer>;
  /** Exhaust pagination or fail. Never return a successful truncated account snapshot. */
  listWallets(customerPartyId: string): Promise<SandboxWallet[]>;
}

/** Only an explicit, documented rejection may use rejected; transport failures are unknown. */
export class SandboxGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: 'unknown' | 'rejected',
  ) {
    super('The sandbox provider action could not be completed.');
    this.name = 'SandboxGatewayError';
  }
}
