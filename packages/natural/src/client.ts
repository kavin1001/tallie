import { z } from 'zod';
import {
  validateSandboxKey,
  type NaturalAgentConfig,
  type NaturalProvisioningConfig,
} from './config';
import { NaturalProviderError } from './errors';
import { SandboxTransport, type NaturalClientOptions } from './transport';
import * as c from './contracts';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NaturalProviderError('invalid_input', 'not_submitted');
  return parsed.data;
}
function bound(condition: boolean, mutation = false): asserts condition {
  if (!condition)
    throw new NaturalProviderError('binding_mismatch', mutation ? 'unknown' : 'not_submitted');
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

/** Administrative credentials only provision identities and simulate test funding. */
export class NaturalProvisioningClient {
  readonly #transport: SandboxTransport;
  constructor(config: NaturalProvisioningConfig, options: NaturalClientOptions = {}) {
    if (config.environment !== 'sandbox')
      throw new NaturalProviderError('configuration', 'not_submitted');
    validateSandboxKey(config.apiKey, 'provisioning');
    this.#transport = new SandboxTransport(config.apiKey, options);
  }
  getOwnParty(): Promise<c.NaturalParty> {
    return this.#transport.request('/parties/me', c.partyResponse);
  }
  async getAgent(agentId: string): Promise<c.NaturalAgent> {
    const id = input(c.agentIdSchema, agentId);
    const agent = await this.#transport.request(`/agents/${id}`, c.agentResponse);
    bound(agent.id === id);
    return agent;
  }
  async getCustomer(customerPartyId: string): Promise<c.NaturalCustomer> {
    const id = input(c.partyIdSchema, customerPartyId);
    const customer = await this.#transport.request(`/customers/${id}`, c.customerResponse);
    bound(customer.id === id);
    return customer;
  }
  async createSandboxInvitation(
    value: c.CreateSandboxInvitationInput,
  ): Promise<c.NaturalSandboxInvitation> {
    const data = input(c.inviteInput, value);
    if (new Set(data.permissions).size !== data.permissions.length)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const result = await this.#transport.request('/simulations/invite-customer', c.inviteResponse, {
      operation: data.operation,
      attributes: { agentIds: [data.agentId], permissions: data.permissions, type: 'PERSON' },
    });
    const invite = result.invitations[0]!;
    bound(
      invite.agentId === data.agentId &&
        sameSet(invite.permissions, data.permissions) &&
        invite.status === 'PENDING' &&
        invite.effectiveStatus === 'PENDING' &&
        invite.customerPartyId === null,
      true,
    );
    return result;
  }
  async acceptSandboxInvitation(
    value: c.AcceptSandboxInvitationInput,
  ): Promise<c.NaturalInvitation> {
    const data = input(c.acceptInput, value);
    const result = await this.#transport.request(
      `/simulations/customer-invitations/${data.invitationId}/accept`,
      c.invitationResponse,
      {
        operation: data.operation,
        attributes: { partyId: data.customerPartyId },
      },
    );
    bound(
      result.id === data.invitationId &&
        result.agentId === data.agentId &&
        result.customerPartyId === data.customerPartyId &&
        result.status === 'ACCEPTED' &&
        result.effectiveStatus === 'ACCEPTED',
      true,
    );
    return result;
  }
  /** Sandbox simulation only. This method cannot address Natural's production origin. */
  async fundSandboxCustomer(value: c.FundSandboxCustomerInput): Promise<c.NaturalSandboxDeposit> {
    const data = input(c.fundSandboxCustomerInput, value);
    const ownParty = await this.getOwnParty();
    if (data.customerPartyId === ownParty.id)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const customer = await this.getCustomer(data.customerPartyId);
    bound(customer.delegation.status === 'ACTIVE');
    // Customer wallet reads require the customer's bound agent credential.
    // The application gateway validates that wallet before calling this party-key
    // simulation; the response below must still bind to the exact customer/wallet.
    const result = await this.#transport.request(
      `/simulations/customers/${data.customerPartyId}/transfers/deposit`,
      c.sandboxDepositResponse,
      {
        operation: data.operation,
        attributes: { amount: data.amount, currency: data.currency, walletId: data.walletId },
      },
    );
    bound(
      result.partyId === data.customerPartyId &&
        result.walletId === data.walletId &&
        result.amount === data.amount &&
        result.currency === data.currency &&
        result.type === 'deposit',
      true,
    );
    return result;
  }
}

/** Customer money paths always use a sandbox agent key and explicit non-platform actor. */
export class NaturalAgentClient {
  readonly #transport: SandboxTransport;
  readonly #agentId: string;
  readonly #platformPartyId: string;
  constructor(config: NaturalAgentConfig, options: NaturalClientOptions = {}) {
    if (config.environment !== 'sandbox')
      throw new NaturalProviderError('configuration', 'not_submitted');
    validateSandboxKey(config.apiKey, 'agent');
    this.#agentId = input(c.agentIdSchema, config.agentId);
    this.#platformPartyId = input(c.partyIdSchema, config.platformPartyId);
    this.#transport = new SandboxTransport(config.apiKey, options);
  }
  #customer(value: string): string {
    const id = input(c.partyIdSchema, value);
    if (id === this.#platformPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    return id;
  }
  async getOwnParty(): Promise<c.NaturalParty> {
    const party = await this.#transport.request('/parties/me', c.partyResponse);
    bound(party.id === this.#platformPartyId);
    return party;
  }
  /** Resource ownership only; this does not prove which agent the credential is bound to. */
  async getAgent(): Promise<c.NaturalAgent> {
    const agent = await this.#transport.request(`/agents/${this.#agentId}`, c.agentResponse);
    bound(agent.id === this.#agentId && agent.partyId === this.#platformPartyId);
    return agent;
  }
  async getCustomer(customerPartyId: string): Promise<c.NaturalCustomer> {
    const id = this.#customer(customerPartyId);
    const customer = await this.#transport.request(`/customers/${id}`, c.customerResponse);
    bound(customer.id === id);
    return customer;
  }
  async listWallets(customerPartyId: string): Promise<c.NaturalWalletPage> {
    const id = this.#customer(customerPartyId);
    const result = await this.#transport.request(
      `/wallets?customerPartyId=${id}`,
      c.walletsResponse,
    );
    bound(
      result.wallets.every((wallet) => wallet.partyId === id) &&
        new Set(result.wallets.map((wallet) => wallet.id)).size === result.wallets.length,
    );
    return result;
  }
  async getWallet(value: { customerPartyId: string; walletId: string }): Promise<c.NaturalWallet> {
    const data = input(
      z.strictObject({ customerPartyId: c.partyIdSchema, walletId: c.walletIdSchema }),
      value,
    );
    const id = this.#customer(data.customerPartyId);
    const wallet = await this.#transport.request(
      `/wallets/${data.walletId}?customerPartyId=${id}`,
      c.walletResponse,
    );
    bound(wallet.id === data.walletId && wallet.partyId === id);
    return wallet;
  }
  /** Canonical read only; a balance change never proves that a deposit completed. */
  async getDeposit(value: c.GetDepositInput): Promise<c.NaturalSandboxDeposit> {
    const data = input(c.depositReadInput, value);
    const customer = this.#customer(data.customerPartyId);
    const result = await this.#transport.request(
      `/transfers/${data.transferId}?customerPartyId=${customer}`,
      c.sandboxDepositResponse,
    );
    bound(
      result.id === data.transferId &&
        result.partyId === customer &&
        result.walletId === data.walletId &&
        result.amount === data.amount &&
        result.currency === 'USD' &&
        result.type === 'deposit',
    );
    return result;
  }
  async listExternalAccounts(value: {
    customerPartyId: string;
    cursor?: string;
    limit?: number;
  }): Promise<c.NaturalExternalAccountPage> {
    const data = input(
      z.strictObject({
        customerPartyId: c.partyIdSchema,
        cursor: z.string().min(1).max(1024).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      value,
    );
    const id = this.#customer(data.customerPartyId);
    const params = new URLSearchParams({ customerPartyId: id });
    if (data.cursor) params.set('cursor', data.cursor);
    if (data.limit) params.set('limit', String(data.limit));
    const result = await this.#transport.request(
      `/external-accounts?${params}`,
      c.externalAccountsResponse,
    );
    bound(result.externalAccounts.every((account) => account.partyId === id));
    return result;
  }
  async getExternalAccount(value: {
    customerPartyId: string;
    externalAccountId: string;
  }): Promise<c.NaturalExternalAccount> {
    const data = input(
      z.strictObject({
        customerPartyId: c.partyIdSchema,
        externalAccountId: c.externalAccountIdSchema,
      }),
      value,
    );
    const id = this.#customer(data.customerPartyId);
    const account = await this.#transport.request(
      `/external-accounts/${data.externalAccountId}?customerPartyId=${id}`,
      c.externalAccountResponse,
    );
    bound(account.id === data.externalAccountId && account.partyId === id);
    return account;
  }
  #requestBound(
    request: c.NaturalPaymentRequestAcknowledgement,
    expected: c.NaturalRequestBinding,
    mutation: boolean,
  ): void {
    bound(
      request.requesterPartyId === expected.requesterPartyId &&
        request.payerPartyId === expected.payerPartyId &&
        request.reportedPayerPartyId === expected.payerPartyId &&
        request.payerIdentifierType === 'party_id' &&
        request.payerIdentifier === expected.payerPartyId &&
        request.amount === expected.amount &&
        request.currency === expected.currency &&
        request.initiatorAgentId === this.#agentId,
      mutation,
    );
  }
  async createPaymentRequest(
    value: c.CreatePaymentRequestInput,
  ): Promise<c.NaturalPaymentRequestAcknowledgement> {
    const data = input(c.createRequestInput, value);
    const actor = this.#customer(data.customerPartyId);
    this.#customer(data.payerPartyId);
    if (actor === data.payerPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    await this.getWallet({ customerPartyId: actor, walletId: data.walletId });
    const result = await this.#transport.request('/payment-requests', c.requestCreatedResponse, {
      operation: data.operation,
      attributes: {
        customerPartyId: actor,
        walletId: data.walletId,
        amount: data.amount,
        currency: data.currency,
        payer: { type: 'party_id', value: data.payerPartyId },
        ...(data.description !== undefined ? { description: data.description } : {}),
        tags: { app_operation_id: data.operation.instanceId },
      },
    });
    this.#requestBound(
      result,
      {
        requesterPartyId: actor,
        walletId: data.walletId,
        payerPartyId: data.payerPartyId,
        amount: data.amount,
        currency: data.currency,
      },
      true,
    );
    bound(result.tags.app_operation_id === data.operation.instanceId, true);
    return result;
  }
  async getPaymentRequest(value: c.GetPaymentRequestInput): Promise<c.NaturalPaymentRequest> {
    const data = input(c.requestReadInput, value);
    const actor = this.#customer(data.customerPartyId);
    if (actor !== data.expected.requesterPartyId && actor !== data.expected.payerPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const result = await this.#transport.request(
      `/payment-requests/${data.paymentRequestId}?customerPartyId=${actor}`,
      c.requestResponse,
    );
    this.#requestBound(result, data.expected, false);
    bound(result.id === data.paymentRequestId && result.walletId === data.expected.walletId);
    return result;
  }
  async cancelPaymentRequest(value: c.CancelPaymentRequestInput): Promise<c.NaturalPaymentRequest> {
    const data = input(c.cancelRequestInput, value);
    const actor = this.#customer(data.customerPartyId);
    if (actor !== data.expected.requesterPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    this.#customer(data.expected.payerPartyId);
    await this.getPaymentRequest({
      customerPartyId: actor,
      paymentRequestId: data.paymentRequestId,
      expected: data.expected,
    });
    const result = await this.#transport.request(
      `/payment-requests/${data.paymentRequestId}/cancel`,
      c.requestResponse,
      { operation: data.operation, attributes: { customerPartyId: actor } },
    );
    this.#requestBound(result, data.expected, true);
    bound(result.id === data.paymentRequestId && result.walletId === data.expected.walletId, true);
    // A fulfilled/canceled race can return a different status: the caller must reconcile it.
    return result;
  }
  #paymentBound(
    payment: c.NaturalPayment,
    expected: c.NaturalPaymentBinding,
    mutation: boolean,
  ): void {
    bound(
      payment.senderPartyId === expected.senderPartyId &&
        payment.recipientPartyId === expected.recipientPartyId &&
        payment.paymentRequestId === expected.paymentRequestId &&
        payment.amount === expected.amount &&
        payment.currency === expected.currency &&
        payment.senderAgentId === this.#agentId,
      mutation,
    );
  }
  #directPaymentBound(
    payment: c.NaturalPayment,
    expected: c.NaturalDirectPaymentBinding,
    mutation: boolean,
  ): void {
    bound(
      payment.senderPartyId === expected.senderPartyId &&
        payment.recipientPartyId === expected.recipientPartyId &&
        payment.paymentRequestId === null &&
        payment.amount === expected.amount &&
        payment.currency === expected.currency &&
        payment.senderAgentId === this.#agentId,
      mutation,
    );
  }
  /** Direct wallet payment to a known Natural party, with explicit customer delegation. */
  async createDirectWalletPayment(
    value: c.CreateDirectWalletPaymentInput,
  ): Promise<c.NaturalPayment> {
    const data = input(c.createDirectWalletPaymentInput, value);
    const actor = this.#customer(data.customerPartyId);
    const recipient = this.#customer(data.recipientPartyId);
    if (actor === recipient) throw new NaturalProviderError('invalid_input', 'not_submitted');
    const customer = await this.getCustomer(actor);
    bound(
      customer.delegation.status === 'ACTIVE' &&
        customer.delegation.permissions.includes('payments.create') &&
        customer.agents.some(
          (agent) =>
            agent.id === this.#agentId &&
            agent.status === 'ACTIVE' &&
            agent.permissions.includes('payments.create'),
        ),
    );
    const wallet = await this.getWallet({ customerPartyId: actor, walletId: data.walletId });
    bound(wallet.status === 'active' && wallet.walletType === 'standard');
    // The payment response has no source-wallet relationship. The exact source is
    // selected in the immutable POST body after the ownership precheck above.
    const result = await this.#transport.request('/payments', c.paymentResponse, {
      operation: data.operation,
      attributes: {
        customerPartyId: actor,
        walletId: data.walletId,
        amount: data.amount,
        currency: data.currency,
        counterparty: { type: 'party_id', value: recipient },
        ...(data.description !== undefined ? { description: data.description } : {}),
        tags: { app_operation_id: data.operation.instanceId },
      },
    });
    this.#directPaymentBound(
      result,
      {
        senderPartyId: actor,
        recipientPartyId: recipient,
        amount: data.amount,
        currency: data.currency,
      },
      true,
    );
    bound(result.tags.app_operation_id === data.operation.instanceId, true);
    return result;
  }
  /** Sent payments only; callers must paginate before concluding an operation is absent. */
  async listPayments(value: c.ListPaymentsInput): Promise<c.NaturalPaymentPage> {
    const data = input(c.listPaymentsInput, value);
    const actor = this.#customer(data.customerPartyId);
    const params = new URLSearchParams({ customerPartyId: actor });
    if (data.cursor) params.set('cursor', data.cursor);
    if (data.limit) params.set('limit', String(data.limit));
    const result = await this.#transport.request(`/payments?${params}`, c.paymentsResponse);
    bound(
      result.payments.every((payment) => payment.senderPartyId === actor) &&
        new Set(result.payments.map((payment) => payment.id)).size === result.payments.length,
    );
    return result;
  }
  async getDirectPayment(value: c.GetDirectPaymentInput): Promise<c.NaturalPayment> {
    const data = input(c.directPaymentReadInput, value);
    const actor = this.#customer(data.customerPartyId);
    if (actor !== data.expected.senderPartyId && actor !== data.expected.recipientPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const result = await this.#transport.request(
      `/payments/${data.paymentId}?customerPartyId=${actor}`,
      c.paymentResponse,
    );
    this.#directPaymentBound(result, data.expected, false);
    bound(result.id === data.paymentId);
    return result;
  }
  async fulfillPaymentRequest(value: c.FulfillPaymentRequestInput): Promise<c.NaturalPayment> {
    const data = input(c.fulfillRequestInput, value);
    const actor = this.#customer(data.customerPartyId);
    this.#customer(data.expected.requesterPartyId);
    if (actor !== data.expected.payerPartyId || actor === data.expected.requesterPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    // Confirm the immutable request and ownership of the exact source before any mutation.
    // Availability/fees and user approval are still the durable service's responsibility.
    await this.getPaymentRequest({
      customerPartyId: actor,
      paymentRequestId: data.paymentRequestId,
      expected: data.expected,
    });
    if (data.paymentSource.type === 'wallet') {
      await this.getWallet({ customerPartyId: actor, walletId: data.paymentSource.walletId });
    } else {
      await this.getExternalAccount({
        customerPartyId: actor,
        externalAccountId: data.paymentSource.externalAccountId,
      });
    }
    const result = await this.#transport.request(
      `/payment-requests/${data.paymentRequestId}/fulfill`,
      c.paymentResponse,
      {
        operation: data.operation,
        attributes: {
          customerPartyId: actor,
          paymentSource: data.paymentSource,
          tags: { app_operation_id: data.operation.instanceId },
        },
      },
    );
    this.#paymentBound(
      result,
      {
        senderPartyId: actor,
        recipientPartyId: data.expected.requesterPartyId,
        paymentRequestId: data.paymentRequestId,
        amount: data.expected.amount,
        currency: data.expected.currency,
      },
      true,
    );
    bound(result.tags.app_operation_id === data.operation.instanceId, true);
    return result;
  }
  async getPayment(value: c.GetPaymentInput): Promise<c.NaturalPayment> {
    const data = input(c.paymentReadInput, value);
    const actor = this.#customer(data.customerPartyId);
    if (actor !== data.expected.senderPartyId && actor !== data.expected.recipientPartyId)
      throw new NaturalProviderError('invalid_input', 'not_submitted');
    const result = await this.#transport.request(
      `/payments/${data.paymentId}?customerPartyId=${actor}`,
      c.paymentResponse,
    );
    this.#paymentBound(result, data.expected, false);
    bound(result.id === data.paymentId);
    return result;
  }
}
