import { describe, expect, it, vi } from 'vitest';
import {
  NaturalProviderError,
  type NaturalCustomer,
  type NaturalPayment,
  type NaturalSandboxDeposit,
  type NaturalWallet,
  type NaturalWalletPage,
} from '@tallie/natural';
import { SandboxGatewayError } from '@tallie/payments';
import { createSandboxSendGateway } from './send-gateway';
import type { SandboxPaymentsConfiguration } from './configuration';

const platformPartyId = `pty_${'0'.repeat(32)}`;
const senderPartyId = `pty_${'1'.repeat(32)}`;
const recipientPartyId = `pty_${'2'.repeat(32)}`;
const agentId = `agt_${'3'.repeat(32)}`;
const walletId = `wal_${'4'.repeat(32)}`;
const paymentId = `pay_${'5'.repeat(32)}`;
const transferId = `trf_${'6'.repeat(32)}`;
const operationId = 'operation_123';
const idempotencyKey = 'idempotency_123';

const config: SandboxPaymentsConfiguration = {
  provisioning: { environment: 'sandbox', apiKey: 'sk_ntl_sandbox_test_only' },
  agent: {
    environment: 'sandbox',
    apiKey: 'ak_ntl_sandbox_test_only',
    agentId,
    platformPartyId,
  },
};

const wallet: NaturalWallet = {
  id: walletId,
  partyId: senderPartyId,
  status: 'active',
  walletType: 'standard',
  isDefault: true,
  agentDefault: true,
  displayName: 'Private provider label',
  balance: { available: 1200, total: 1400, currency: 'USD' },
};
const customer: NaturalCustomer = {
  id: senderPartyId,
  delegation: {
    id: `dlg_${'7'.repeat(32)}`,
    status: 'ACTIVE',
    permissions: ['payments.create'],
  },
  agents: [{ id: agentId, status: 'ACTIVE', permissions: ['payments.create'] }],
};
const deposit: NaturalSandboxDeposit = {
  id: transferId,
  type: 'deposit',
  amount: 1000,
  currency: 'USD',
  status: 'COMPLETED',
  partyId: senderPartyId,
  walletId,
};
const payment: NaturalPayment = {
  id: paymentId,
  amount: 500,
  currency: 'USD',
  status: 'PROCESSING',
  tags: { app_operation_id: operationId },
  fee: null,
  senderPartyId,
  recipientPartyId,
  senderAgentId: agentId,
  paymentRequestId: null,
};

function fixture() {
  const provisioning = { fundSandboxCustomer: vi.fn(async () => deposit) };
  const agent = {
    getCustomer: vi.fn(async () => customer),
    getWallet: vi.fn(async () => wallet),
    listWallets: vi.fn(async (): Promise<NaturalWalletPage> => ({
      wallets: [wallet],
      hasMore: false,
      nextCursor: null,
    })),
    createDirectWalletPayment: vi.fn(async () => payment),
    getDirectPayment: vi.fn(async () => payment),
    listPayments: vi.fn(async () => ({
      payments: [payment],
      hasMore: true,
      nextCursor: 'next_page',
    })),
  };
  return {
    provisioning,
    agent,
    gateway: createSandboxSendGateway(config, { provisioning, agent }),
  };
}

describe('sandbox send gateway', () => {
  it('passes exact actor, wallet, party recipient, amount, and stable operation to Natural', async () => {
    const { gateway, agent } = fixture();
    const result = await gateway.send({
      senderPartyId,
      walletId,
      recipientPartyId,
      amount: 500,
      description: 'Dinner',
      operationId,
      idempotencyKey,
    });
    expect(agent.createDirectWalletPayment).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: senderPartyId,
      walletId,
      recipientPartyId,
      amount: 500,
      currency: 'USD',
      description: 'Dinner',
      operation: { instanceId: operationId, idempotencyKey },
    });
    expect(result).toEqual({
      id: paymentId,
      amount: 500,
      currency: 'USD',
      status: 'PROCESSING',
      senderPartyId,
      recipientPartyId,
      senderAgentId: agentId,
      paymentRequestId: null,
      tags: { app_operation_id: operationId },
    });
    expect(result).not.toHaveProperty('fee');
  });

  it('funds through the provisioning simulation with the saved operation identifiers', async () => {
    const { gateway, provisioning, agent } = fixture();
    expect(
      await gateway.fund({
        customerPartyId: senderPartyId,
        walletId,
        amount: 1000,
        operationId,
        idempotencyKey,
      }),
    ).toEqual({ id: transferId, status: 'COMPLETED', amount: 1000, currency: 'USD' });
    expect(agent.getWallet).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: senderPartyId,
      walletId,
    });
    expect(agent.getWallet.mock.invocationCallOrder[0]).toBeLessThan(
      provisioning.fundSandboxCustomer.mock.invocationCallOrder[0]!,
    );
    expect(provisioning.fundSandboxCustomer).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: senderPartyId,
      walletId,
      amount: 1000,
      currency: 'USD',
      operation: { instanceId: operationId, idempotencyKey },
    });
  });

  it.each([
    { id: `wal_${'9'.repeat(32)}` },
    { partyId: recipientPartyId },
    { status: 'frozen' as const },
    { walletType: 'vault' as const },
  ])('does not fund an unavailable or unrelated wallet: %j', async (patch) => {
    const { gateway, provisioning, agent } = fixture();
    agent.getWallet.mockResolvedValue({ ...wallet, ...patch });
    await expect(
      gateway.fund({
        customerPartyId: senderPartyId,
        walletId,
        amount: 1000,
        operationId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_WALLET_MISMATCH', outcome: 'rejected' });
    expect(provisioning.fundSandboxCustomer).not.toHaveBeenCalled();
  });

  it('does not submit a deposit when the agent wallet read fails', async () => {
    const { gateway, provisioning, agent } = fixture();
    agent.getWallet.mockRejectedValue(new NaturalProviderError('http', 'not_submitted', 403));
    await expect(
      gateway.fund({
        customerPartyId: senderPartyId,
        walletId,
        amount: 1000,
        operationId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(provisioning.fundSandboxCustomer).not.toHaveBeenCalled();
  });

  it('maps customer, wallet, payment detail, and paginated payment reads without extra data', async () => {
    const { gateway, agent } = fixture();
    expect(await gateway.getCustomer(senderPartyId)).toEqual(customer);
    expect(agent.getCustomer).toHaveBeenCalledExactlyOnceWith(senderPartyId);
    expect(await gateway.getWallet({ customerPartyId: senderPartyId, walletId })).toEqual({
      id: walletId,
      partyId: senderPartyId,
      status: 'active',
      walletType: 'standard',
      balance: { available: '1200', total: '1400', currency: 'USD' },
    });
    expect(await gateway.listWallets(senderPartyId)).toHaveLength(1);
    expect(
      await gateway.getPayment({
        senderPartyId,
        recipientPartyId,
        amount: 500,
        paymentId,
      }),
    ).toMatchObject({ id: paymentId, status: 'PROCESSING' });
    expect(agent.getDirectPayment).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: senderPartyId,
      paymentId,
      expected: { senderPartyId, recipientPartyId, amount: 500, currency: 'USD' },
    });
    expect(await gateway.listPayments({ senderPartyId, limit: 100, cursor: 'old_page' })).toEqual({
      payments: [expect.objectContaining({ id: paymentId })],
      hasMore: true,
      nextCursor: 'next_page',
    });
    expect(agent.listPayments).toHaveBeenCalledExactlyOnceWith({
      customerPartyId: senderPartyId,
      limit: 100,
      cursor: 'old_page',
    });
  });

  it('preserves a missing wallet balance and rejects a partial wallet snapshot', async () => {
    const { gateway, agent } = fixture();
    agent.getWallet.mockResolvedValue({ ...wallet, balance: null });
    expect(
      (await gateway.getWallet({ customerPartyId: senderPartyId, walletId })).balance,
    ).toBeNull();
    agent.listWallets.mockResolvedValue({ wallets: [wallet], hasMore: true, nextCursor: 'more' });
    await expect(gateway.listWallets(senderPartyId)).rejects.toMatchObject({
      code: 'SANDBOX_WALLET_PAGE_INCOMPLETE',
      outcome: 'rejected',
    });
  });

  it('preserves uncertain mutation outcomes, sanitizes provider errors, and never retries', async () => {
    const { gateway, agent } = fixture();
    agent.createDirectWalletPayment.mockRejectedValueOnce(
      new NaturalProviderError('binding_mismatch', 'unknown'),
    );
    await expect(
      gateway.send({
        senderPartyId,
        walletId,
        recipientPartyId,
        amount: 500,
        description: '',
        operationId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(agent.createDirectWalletPayment).toHaveBeenCalledTimes(1);
    agent.createDirectWalletPayment.mockRejectedValueOnce(new Error('secret test account number'));
    await expect(
      gateway.send({
        senderPartyId,
        walletId,
        recipientPartyId,
        amount: 500,
        description: '',
        operationId,
        idempotencyKey,
      }),
    ).rejects.toThrow('The sandbox provider action could not be completed.');
    expect(agent.createDirectWalletPayment).toHaveBeenCalledTimes(2);
  });

  it('treats documented rejections as rejected and leaves explicit gateway failures intact', async () => {
    const { gateway, agent, provisioning } = fixture();
    agent.createDirectWalletPayment.mockRejectedValueOnce(
      new NaturalProviderError('http', 'rejected', 403),
    );
    await expect(
      gateway.send({
        senderPartyId,
        walletId,
        recipientPartyId,
        amount: 500,
        description: '',
        operationId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    provisioning.fundSandboxCustomer.mockRejectedValueOnce(
      new SandboxGatewayError('TEST_PROVIDER_BLOCKED', 'rejected'),
    );
    await expect(
      gateway.fund({
        customerPartyId: senderPartyId,
        walletId,
        amount: 1000,
        operationId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'TEST_PROVIDER_BLOCKED', outcome: 'rejected' });
  });
});
