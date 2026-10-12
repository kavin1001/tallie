import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerPilotGateway } from '@tallie/payments';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  database: vi.fn(),
  verifiedPhoneFor: vi.fn(),
  client: vi.fn(),
  service: vi.fn(),
  getOwnerWallet: vi.fn(),
  send: vi.fn(),
  getPayment: vi.fn(),
  findPayment: vi.fn(),
}));
vi.mock('@tallie/app-services/owner-pilot', () => ({ readOwnerPilotRuntimeConfig: mocks.config }));
vi.mock('@tallie/identity', async (original) => ({
  ...(await original<typeof import('@tallie/identity')>()),
  identityDatabase: mocks.database,
  verifiedPhoneFor: mocks.verifiedPhoneFor,
}));
vi.mock('@tallie/natural', () => ({
  NaturalOwnerPilotClient: class {
    constructor(config: unknown) {
      mocks.client(config);
    }
    getOwnerWallet = mocks.getOwnerWallet;
    send = mocks.send;
    getPayment = mocks.getPayment;
    findPayment = mocks.findPayment;
  },
}));
vi.mock('@tallie/payments', () => ({
  OwnerPilotService: class {
    constructor(...args: unknown[]) {
      mocks.service(...args);
    }
  },
}));
import { ownerPilotAvailable, ownerPilotService } from './owner-pilot';

const settings = {
  enabled: true,
  maxAmountMinor: 100,
  ownerPhoneHash: 'a'.repeat(64),
  recipientHandle: '@fixture_recipient',
  provider: {
    environment: 'production',
    apiKey: 'ak_ntl_prod_fixture',
    platformPartyId: `pty_${'b'.repeat(32)}`,
    agentId: `agt_${'c'.repeat(32)}`,
    walletId: `wal_${'d'.repeat(32)}`,
  },
};
const actor = {
  userId: 'owner-account',
  sessionId: 'owner-session',
  phoneHash: settings.ownerPhoneHash,
  displayName: 'Owner',
};
const wallet = {
  partyId: settings.provider.platformPartyId,
  partyType: 'PERSON',
  status: 'ACTIVE',
  handle: '@fixture_owner',
  primaryPhone: '+12025550101',
  walletId: settings.provider.walletId,
  availableMinor: 400,
  currency: 'USD',
};
const gateway = () => mocks.service.mock.calls[0]![1] as OwnerPilotGateway;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(settings);
  mocks.database.mockReturnValue({ database: 'fixture' });
  mocks.getOwnerWallet.mockResolvedValue(wallet);
  mocks.verifiedPhoneFor.mockResolvedValue('+12025550101');
});
afterEach(() => vi.unstubAllEnvs());

describe('owner pilot web identity binding', () => {
  it('remains unavailable when disabled and constructs no provider or domain client', () => {
    mocks.config.mockReturnValue(null);
    expect(ownerPilotAvailable()).toBe(false);
    expect(() => ownerPilotService(actor)).toThrow('Personal payment testing is unavailable here.');
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('rejects another phone identity before opening provider access', () => {
    expect(() => ownerPilotService({ ...actor, phoneHash: 'f'.repeat(64) })).toThrow(
      'configured wallet owner',
    );
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
  });

  it('binds only the authenticated account and configured payment tuple', async () => {
    expect(ownerPilotAvailable()).toBe(true);
    ownerPilotService(actor);
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith(settings.provider);
    expect(mocks.service.mock.calls[0]![2]).toEqual({
      enabled: true,
      ownerAccountId: actor.userId,
      ownerPhoneHash: settings.ownerPhoneHash,
      platformPartyId: settings.provider.platformPartyId,
      walletId: settings.provider.walletId,
      agentId: settings.provider.agentId,
      recipientHandle: '@fixture_recipient',
      maxAmountMinor: 100,
    });
    expect(await gateway().getOwnerWallet()).toEqual(wallet);
    expect(mocks.verifiedPhoneFor).toHaveBeenCalledExactlyOnceWith(actor.userId);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(['+12025550102', null])(
    'blocks mismatched or absent provider phone %s',
    async (phone) => {
      ownerPilotService(actor);
      mocks.getOwnerWallet.mockResolvedValue({ ...wallet, primaryPhone: phone });
      await expect(gateway().getOwnerWallet()).rejects.toMatchObject({
        code: 'OWNER_PILOT_NOT_AUTHORIZED',
        status: 403,
      });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it('does not replace missing verified phone evidence or expose phone values in errors', async () => {
    ownerPilotService(actor);
    mocks.verifiedPhoneFor.mockResolvedValue(null);
    try {
      await gateway().getOwnerWallet();
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'OWNER_PILOT_NOT_AUTHORIZED' });
      expect(String(error)).not.toContain(wallet.primaryPhone);
      expect(String(error)).not.toContain(settings.provider.apiKey);
    }
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('forwards only typed operation and read inputs through the fixed provider client', async () => {
    ownerPilotService(actor);
    const input = {
      walletId: settings.provider.walletId,
      recipientHandle: '@fixture_recipient',
      amountMinor: 100,
      operationId: 'operation-fixture',
      idempotencyKey: 'idempotency-fixture',
    };
    await gateway().send(input);
    await gateway().getPayment('payment-fixture');
    await gateway().findPayment('operation-fixture');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocks.getPayment).toHaveBeenCalledExactlyOnceWith('payment-fixture');
    expect(mocks.findPayment).toHaveBeenCalledExactlyOnceWith('operation-fixture');
  });
});
