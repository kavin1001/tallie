import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  productionConnectionAvailable,
  readProductionConnectionConfiguration,
} from './production-connection';
const env = {
  APP_MODE: 'beta',
  APP_ORIGIN: 'https://tallie.example',
  NATURAL_PRODUCTION_CONNECT_ENABLED: 'true',
  NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '10000',
  NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'1'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'2'.repeat(32)}`,
  NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
  NATURAL_PRODUCTION_WEBHOOK_SECRET: `whsec_${randomBytes(32).toString('base64')}`,
  IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};
describe('production account activation configuration', () => {
  it('defaults off without reading or requiring credentials', () => {
    expect(readProductionConnectionConfiguration({})).toBeNull();
    expect(productionConnectionAvailable({})).toBe(false);
    expect(productionConnectionAvailable({ ...env, APP_PREVIEW_MODE: 'true' })).toBe(false);
    expect(productionConnectionAvailable(env)).toBe(true);
    expect(
      readProductionConnectionConfiguration({
        ...env,
        NATURAL_PRODUCTION_CONNECT_ENABLED: 'false',
        NATURAL_PRODUCTION_API_KEY: 'bad',
      }),
    ).toBeNull();
  });
  it('constructs configuration without external calls and scopes the explicit delegation limit', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(readProductionConnectionConfiguration(env)?.connection).toEqual({
        enabled: true,
        environment: 'production',
        platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
        agentId: env.NATURAL_PRODUCTION_AGENT_ID,
        perTransactionLimitMinor: 10000,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it.each([
    { APP_MODE: 'demo' },
    { APP_PREVIEW_MODE: 'true' },
    { IDENTITY_PHONE_DEMO_ENABLED: 'true' },
    { APP_ORIGIN: 'http://localhost:3001' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '10001' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '1.5' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '0' },
    { NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_fixture' },
    { NATURAL_PRODUCTION_API_KEY: 'sk_ntl_sandbox_fixture' },
    { NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'false' },
    { NATURAL_PRODUCTION_WEBHOOK_SECRET: 'invalid' },
    { IDENTITY_ENCRYPTION_KEY: '' },
  ])('fails closed with incomplete/mixed activation configuration: %j', (patch) => {
    expect(() => readProductionConnectionConfiguration({ ...env, ...patch })).toThrow(
      'Payment account setup is not available yet.',
    );
  });
});
