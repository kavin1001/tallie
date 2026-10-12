import { describe, expect, it, vi } from 'vitest';
import { readOwnerPilotRuntimeConfig } from './owner-pilot';

const env = {
  NATURAL_OWNER_PILOT_ENABLED: 'true',
  NATURAL_OWNER_PILOT_LOCAL: 'true',
  APP_ORIGIN: 'http://localhost:3004',
  APP_HOST: '127.0.0.1',
  PORT: '3004',
  APP_MODE: 'beta',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/tallie_owner_pilot',
  NATURAL_OWNER_PILOT_PHONE_HASH: 'a'.repeat(64),
  NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: '@fixture_recipient',
  NATURAL_OWNER_PILOT_WALLET_ID: `wal_${'b'.repeat(32)}`,
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'c'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'d'.repeat(32)}`,
};

describe('isolated local owner pilot configuration', () => {
  it('defaults disabled without reading credentials or parsing the database', () => {
    expect(readOwnerPilotRuntimeConfig({})).toBeNull();
    expect(
      readOwnerPilotRuntimeConfig({
        ...env,
        NATURAL_OWNER_PILOT_ENABLED: 'false',
        DATABASE_URL: 'malformed',
      }),
    ).toBeNull();
  });

  it('fixes the payment cap and exact source/owner/recipient without network calls', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const result = readOwnerPilotRuntimeConfig({
        ...env,
        NATURAL_OWNER_PILOT_MAX_AMOUNT_MINOR: '10000',
      });
      expect(result).toMatchObject({
        enabled: true,
        maxAmountMinor: 100,
        ownerPhoneHash: env.NATURAL_OWNER_PILOT_PHONE_HASH,
        recipientHandle: env.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE,
        provider: {
          environment: 'production',
          walletId: env.NATURAL_OWNER_PILOT_WALLET_ID,
          platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
          agentId: env.NATURAL_PRODUCTION_AGENT_ID,
        },
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    { NATURAL_OWNER_PILOT_LOCAL: 'false' },
    { APP_ORIGIN: 'https://tallie.example' },
    { APP_ORIGIN: 'http://127.0.0.1:3004' },
    { APP_ORIGIN: 'http://localhost:3004/' },
    { APP_HOST: '0.0.0.0' },
    { PORT: '3001' },
    { APP_MODE: 'demo' },
    { DATABASE_URL: 'postgresql://fixture:fixture@db.example/tallie_owner_pilot' },
    { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/tallie' },
    {
      DATABASE_URL:
        'postgresql://fixture:fixture@127.0.0.1/tallie_owner_pilot?options=-c%20search_path=other',
    },
    { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/tallie_owner_pilot#other' },
    { DATABASE_URL: 'https://127.0.0.1/tallie_owner_pilot' },
    { NATURAL_OWNER_PILOT_PHONE_HASH: 'invalid' },
    { NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: 'fixture_recipient' },
    { NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: '@fixture/recipient' },
    { NATURAL_OWNER_PILOT_WALLET_ID: 'arbitrary-wallet' },
    { NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_fixture' },
    { NATURAL_PRODUCTION_AGENT_ID: '' },
    { NATURAL_PRODUCTION_PLATFORM_PARTY_ID: '' },
  ])('rejects mixed, remote or incomplete settings: %j', (patch) => {
    expect(() => readOwnerPilotRuntimeConfig({ ...env, ...patch })).toThrow();
  });

  it.each([
    'APP_PREVIEW_MODE',
    'IDENTITY_PHONE_DEMO_ENABLED',
    'NATURAL_SANDBOX_ENABLED',
    'NATURAL_PRODUCTION_CONNECT_ENABLED',
    'NATURAL_PRODUCTION_WEBHOOK_ENABLED',
    'NATURAL_PRODUCTION_PAYMENTS_ENABLED',
    'NATURAL_RECONCILIATION_ENABLED',
    'NATURAL_SANDBOX_WEBHOOK_ENABLED',
    'RECEIPTS_ENABLED',
    'MESSAGING_SEND_ENABLED',
  ])('rejects unrelated enabled feature %s', (key) => {
    expect(() => readOwnerPilotRuntimeConfig({ ...env, [key]: 'true' })).toThrow();
  });
});
