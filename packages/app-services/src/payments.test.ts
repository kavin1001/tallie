import { describe, expect, it, vi } from 'vitest';
import { createPaymentReadGateway, readPaymentWorkerConfiguration } from './payments';

const env = {
  APP_MODE: 'beta',
  NATURAL_RECONCILIATION_ENABLED: 'true',
  NATURAL_ENVIRONMENT: 'sandbox',
  NATURAL_AGENT_KEY: 'ak_ntl_sandbox_fixture',
  NATURAL_AGENT_ID: `agt_${'a'.repeat(32)}`,
  NATURAL_PLATFORM_PARTY_ID: `pty_${'b'.repeat(32)}`,
};
describe('payment maintenance capability boundary', () => {
  it('requires explicit activation and an agent sandbox credential only', () => {
    expect(readPaymentWorkerConfiguration({})).toBeNull();
    expect(readPaymentWorkerConfiguration(env)?.apiKey).toBe(env.NATURAL_AGENT_KEY);
    for (const patch of [
      { NATURAL_ENVIRONMENT: 'production' },
      { NATURAL_AGENT_KEY: 'ak_ntl_prod_fixture' },
      { APP_MODE: 'production' },
    ])
      expect(() => readPaymentWorkerConfiguration({ ...env, ...patch })).toThrow();
  });
  it('exposes only reads and preserves every financial binding', async () => {
    const client = { getDirectPayment: vi.fn(), listPayments: vi.fn(), getDeposit: vi.fn() };
    const gateway = createPaymentReadGateway(readPaymentWorkerConfiguration(env)!, client);
    expect(Object.keys(gateway).sort()).toEqual(['getDeposit', 'getPayment', 'listPayments']);
    await gateway.getPayment({
      senderPartyId: 'sender',
      recipientPartyId: 'recipient',
      amount: 100,
      paymentId: 'saved-payment',
    });
    expect(client.getDirectPayment).toHaveBeenCalledWith({
      customerPartyId: 'sender',
      paymentId: 'saved-payment',
      expected: {
        senderPartyId: 'sender',
        recipientPartyId: 'recipient',
        amount: 100,
        currency: 'USD',
      },
    });
    await gateway.getDeposit({
      customerPartyId: 'sender',
      walletId: 'saved-wallet',
      amount: 500,
      transferId: 'saved-transfer',
    });
    expect(client.getDeposit).toHaveBeenCalledWith({
      customerPartyId: 'sender',
      walletId: 'saved-wallet',
      amount: 500,
      transferId: 'saved-transfer',
    });
    await gateway.listPayments({ senderPartyId: 'sender', cursor: 'saved-cursor', limit: 100 });
    expect(client.listPayments).toHaveBeenCalledWith({
      customerPartyId: 'sender',
      cursor: 'saved-cursor',
      limit: 100,
    });
  });
});
