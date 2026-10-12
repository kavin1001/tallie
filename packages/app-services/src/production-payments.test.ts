import { describe, expect, it, vi } from 'vitest';
import {
  createProductionConnectionReadGateway,
  readProductionPaymentWorkerConfiguration,
  configuredProductionConnections,
} from './production-payments';
import type { PaymentDatabase } from '@tallie/payments';
import type { Kysely } from 'kysely';
const env = {
  APP_MODE: 'beta',
  APP_ORIGIN: 'https://tallie.example',
  NATURAL_PRODUCTION_CONNECT_ENABLED: 'true',
  NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
  NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '10000',
  NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'a'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'b'.repeat(32)}`,
};
describe('production activation maintenance capability boundary', () => {
  it('defaults disabled and works without signing/encryption secrets', () => {
    expect(readProductionPaymentWorkerConfiguration({})).toBeNull();
    const config = readProductionPaymentWorkerConfiguration(env);
    expect(config?.connection).toMatchObject({
      enabled: true,
      environment: 'production',
      perTransactionLimitMinor: 10000,
    });
    expect('IDENTITY_ENCRYPTION_KEY' in env).toBe(false);
    expect('NATURAL_PRODUCTION_WEBHOOK_SECRET' in env).toBe(false);
  });
  it.each([
    { APP_MODE: 'demo' },
    { APP_PREVIEW_MODE: 'true' },
    { IDENTITY_PHONE_DEMO_ENABLED: 'true' },
    { NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'false' },
    { APP_ORIGIN: 'http://localhost:3001' },
    { NATURAL_PRODUCTION_API_KEY: 'sk_ntl_sandbox_fixture' },
    { NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_fixture' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '10001' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '0' },
  ])('rejects mixed or incomplete configuration: %j', (patch) => {
    expect(() => readProductionPaymentWorkerConfiguration({ ...env, ...patch })).toThrow();
  });
  it('cannot create invitations and delegates only canonical acceptance/wallet reads', async () => {
    const config = readProductionPaymentWorkerConfiguration(env)!;
    const clients = {
      connect: { verifyAcceptedConnection: vi.fn() },
      wallets: { getReceivingWallet: vi.fn() },
    };
    const gateway = createProductionConnectionReadGateway(config, clients);
    await expect(
      gateway.createInvitation({
        verifiedPhone: '+12025550101',
        returnState: 'a'.repeat(43),
        perTransactionLimitMinor: 10000,
        operation: { instanceId: 'unused', idempotencyKey: 'unused' },
      }),
    ).rejects.toThrow('WORKER_MUTATION_DISABLED');
    expect(clients.connect.verifyAcceptedConnection).not.toHaveBeenCalled();
    expect(clients.wallets.getReceivingWallet).not.toHaveBeenCalled();
    const hint = {
      eventId: `evt_${'c'.repeat(32)}`,
      invitationId: `adi_${'d'.repeat(32)}`,
      perTransactionLimitMinor: 10000,
    };
    await gateway.verifyAcceptedConnection(hint);
    expect(clients.connect.verifyAcceptedConnection).toHaveBeenCalledExactlyOnceWith(hint);
    await gateway.getReceivingWallet('bound-customer');
    expect(clients.wallets.getReceivingWallet).toHaveBeenCalledExactlyOnceWith('bound-customer');
  });
  it('constructs a processor with no external side effects and cannot start an invitation without a vault', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const service = configuredProductionConnections({} as Kysely<PaymentDatabase>, env)!;
      await expect(
        service.start({
          userId: 'unused',
          sessionId: 'unused',
          phoneHash: 'unused',
          displayName: 'unused',
        }),
      ).rejects.toThrow('CONNECTION_UNAVAILABLE');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
