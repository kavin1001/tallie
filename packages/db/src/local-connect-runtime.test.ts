import { mkdtempSync, rmSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localConnectionConfiguration,
  readLocalConnectionSettings,
} from '../../../scripts/run-connect-local.mjs';

const configuration = {
  APP_ORIGIN: 'https://connection-test.example',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55434/tallie_production_connect',
  BETTER_AUTH_SECRET: 'fixture-identity-secret-32-characters',
  IDENTITY_ENCRYPTION_KEY: 'a'.repeat(64),
  SENDBLUE_API_KEY_ID: 'fixture-verification-key',
  SENDBLUE_API_SECRET_KEY: 'fixture-verification-secret',
  SENDBLUE_VERIFY_SERVICE_SID: `SV${'a'.repeat(32)}`,
  NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'a'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'b'.repeat(32)}`,
  NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '1000',
  NATURAL_PRODUCTION_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
};
const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe('isolated local production connection runtime', () => {
  it('uses only the explicit configuration, ignoring inherited providers and startup injection', () => {
    const { environment, command } = localConnectionConfiguration('web', configuration, {
      PATH: '/fixture/path',
      DATABASE_URL: 'postgresql://hosted.example/production',
      APP_MODE: 'demo',
      APP_ORIGIN: 'http://localhost:3001',
      PORT: '3001',
      IDENTITY_PHONE_DEMO_ENABLED: 'true',
      NATURAL_API_KEY: 'sk_ntl_sandbox_inherited',
      NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_wrong',
      OPENAI_API_KEY: 'inherited-receipt-secret',
      AWS_SECRET_ACCESS_KEY: 'inherited-storage-secret',
      NODE_OPTIONS: '--import=/untrusted/script.mjs',
      NODE_EXTRA_CA_CERTS: '/untrusted/certificate',
      RENDER: 'true',
    });
    expect(command).toContain('start');
    expect(command.slice(-2)).toEqual(['--hostname', '127.0.0.1']);
    expect(environment).toMatchObject({
      APP_MODE: 'beta',
      APP_HOST: '127.0.0.1',
      APP_ORIGIN: configuration.APP_ORIGIN,
      DATABASE_URL: configuration.DATABASE_URL,
      PORT: '3003',
      NATURAL_PRODUCTION_AGENT_KEY: configuration.NATURAL_PRODUCTION_AGENT_KEY,
      NATURAL_PRODUCTION_CONNECT_ENABLED: 'true',
      NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
      APP_PREVIEW_MODE: 'false',
      IDENTITY_PHONE_DEMO_ENABLED: 'false',
      NATURAL_SANDBOX_ENABLED: 'false',
      NATURAL_RECONCILIATION_ENABLED: 'false',
      NATURAL_SANDBOX_WEBHOOK_ENABLED: 'false',
      RECEIPTS_ENABLED: 'false',
      MESSAGING_SEND_ENABLED: 'false',
      NATURAL_API_KEY: '',
      NATURAL_AGENT_KEY: '',
      AWS_SECRET_ACCESS_KEY: '',
      OPENAI_API_KEY: '',
    });
    for (const key of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'RENDER'])
      expect(environment).not.toHaveProperty(key);
  });

  it('retains only provider read credentials in the worker, and only the local URL in migrations', () => {
    const worker = localConnectionConfiguration('worker', configuration, {}).environment;
    expect(worker.NATURAL_PRODUCTION_AGENT_KEY).toBe(configuration.NATURAL_PRODUCTION_AGENT_KEY);
    for (const key of [
      'IDENTITY_ENCRYPTION_KEY',
      'BETTER_AUTH_SECRET',
      'NATURAL_PRODUCTION_WEBHOOK_SECRET',
      'SENDBLUE_API_KEY_ID',
      'SENDBLUE_API_SECRET_KEY',
    ])
      expect(worker).not.toHaveProperty(key);
    const migration = localConnectionConfiguration('migrate', configuration, { PATH: '/bin' });
    expect(migration.command.at(-1)).toMatch(/packages\/db\/src\/migrate.ts$/);
    expect(migration.environment).toEqual({
      PATH: '/bin',
      NODE_ENV: 'production',
      DATABASE_URL: configuration.DATABASE_URL,
    });
  });

  it.each([
    'postgresql://fixture:fixture@hosted.example/tallie_production_connect',
    'postgresql://fixture:fixture@127.0.0.1:55434/tallie',
    'postgresql://fixture:fixture@127.0.0.1:55434/tallie_production_connect?options=-csearch_path=public',
    'postgresql://fixture:fixture@127.0.0.1:55434/tallie_production_connect#ignored',
    'https://127.0.0.1/tallie_production_connect',
  ])('rejects shared, remote or redirected database settings', (DATABASE_URL) => {
    expect(() =>
      localConnectionConfiguration('check', { ...configuration, DATABASE_URL }),
    ).toThrow();
  });

  it.each([
    'http://localhost:3003',
    'https://localhost',
    'https://127.0.0.1',
    'https://example.localhost',
    'https://user:secret@connection.example',
    'https://connection.example/path',
    'https://connection.example?extra=1',
    'https://connection.example:3003',
  ])('requires an exact public HTTPS origin', (APP_ORIGIN) => {
    expect(() => localConnectionConfiguration('check', { ...configuration, APP_ORIGIN })).toThrow();
  });

  it.each([
    { APP_MODE: 'demo' },
    { PORT: '3001' },
    { APP_PREVIEW_MODE: 'true' },
    { IDENTITY_PHONE_DEMO_ENABLED: 'true' },
    { NATURAL_SANDBOX_ENABLED: 'true' },
    { NATURAL_RECONCILIATION_ENABLED: 'true' },
    { RECEIPTS_ENABLED: 'true' },
    { MESSAGING_SEND_ENABLED: 'true' },
    { NATURAL_PRODUCTION_CONNECT_ENABLED: 'false' },
    { NATURAL_PRODUCTION_PAYMENTS_ENABLED: 'true' },
    { OPENAI_API_KEY: 'unneeded-secret' },
    { AWS_SECRET_ACCESS_KEY: 'unneeded-secret' },
    { NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_wrong' },
    { NATURAL_PRODUCTION_WEBHOOK_SECRET: 'whsec_invalid' },
    { NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR: '10001' },
    { IDENTITY_ENCRYPTION_KEY: '' },
    { BETTER_AUTH_SECRET: 'short' },
    { SENDBLUE_VERIFY_SERVICE_SID: '' },
  ])('fails closed for missing identity or expanded capabilities', (override) => {
    expect(() =>
      localConnectionConfiguration('check', { ...configuration, ...override }),
    ).toThrow();
  });

  it('validates owner-only local configuration files without returning raw filesystem errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tallie-connect-test-'));
    temporary.push(directory);
    const file = join(directory, 'settings.env');
    writeFileSync(file, 'APP_ORIGIN=https://connection.example\n', { mode: 0o600 });
    expect(readLocalConnectionSettings(file)).toEqual({ APP_ORIGIN: 'https://connection.example' });
    chmodSync(file, 0o644);
    expect(() => readLocalConnectionSettings(file)).toThrow();
    chmodSync(file, 0o600);
    const link = join(directory, 'linked.env');
    symlinkSync(file, link);
    expect(() => readLocalConnectionSettings(link)).toThrow();
  });

  it('rejects unknown launch roles', () => {
    expect(() => localConnectionConfiguration('web-preview', configuration)).toThrow();
  });
});
