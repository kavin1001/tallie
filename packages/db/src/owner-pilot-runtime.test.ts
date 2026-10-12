import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localOwnerPilotConfiguration,
  readLocalOwnerPilotSettings,
} from '../../../scripts/run-owner-pilot.mjs';

const configuration = {
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55434/tallie_owner_pilot',
  BETTER_AUTH_SECRET: 'fixture-identity-secret-32-characters',
  IDENTITY_ENCRYPTION_KEY: 'a'.repeat(64),
  SENDBLUE_API_KEY_ID: 'fixture-verification-key',
  SENDBLUE_API_SECRET_KEY: 'fixture-verification-secret',
  SENDBLUE_VERIFY_SERVICE_SID: `SV${'a'.repeat(32)}`,
  NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_fixture',
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'a'.repeat(32)}`,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'b'.repeat(32)}`,
  NATURAL_OWNER_PILOT_WALLET_ID: `wal_${'c'.repeat(32)}`,
  NATURAL_OWNER_PILOT_PHONE_HASH: 'd'.repeat(64),
  NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: '@recipient',
};
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'tallie-owner-runtime-test-'));
  temporary.push(path);
  return path;
}
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe('isolated local owner pilot launcher', () => {
  it('pins beta passkey identity, owner payment scope and localhost independently of inherited secrets', () => {
    const { command, cwd, environment } = localOwnerPilotConfiguration('web', configuration, {
      PATH: '/fixture/path',
      DATABASE_URL: 'postgresql://hosted.example/production',
      APP_MODE: 'demo',
      APP_ORIGIN: 'https://hosted.example',
      APP_HOST: '0.0.0.0',
      PORT: '3001',
      NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_prod_unrelated',
      NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_inherited',
      NATURAL_AGENT_KEY: 'ak_ntl_sandbox_inherited',
      IDENTITY_PHONE_DEMO_ENABLED: 'true',
      NATURAL_SANDBOX_ENABLED: 'true',
      NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
      NATURAL_PRODUCTION_CONNECT_ENABLED: 'true',
      OPENAI_API_KEY: 'inherited-receipt-secret',
      AWS_SECRET_ACCESS_KEY: 'inherited-storage-secret',
      SENDBLUE_FROM_NUMBER: '+12025550101',
      MESSAGING_SEND_ENABLED: 'true',
      NODE_OPTIONS: '--import=/untrusted/script.mjs',
      NODE_EXTRA_CA_CERTS: '/untrusted/cert',
      LD_PRELOAD: '/untrusted/library',
      DYLD_INSERT_LIBRARIES: '/untrusted/library',
      RENDER: 'true',
      HTTP_PROXY: 'https://proxy.example',
      UNKNOWN_SECRET: 'secret',
    });
    expect(command.slice(1)).toEqual(['start', '--hostname', '127.0.0.1', '--port', '3004']);
    expect(cwd).toMatch(/apps\/web$/);
    expect(environment).toMatchObject({
      PATH: '/fixture/path',
      DATABASE_URL: configuration.DATABASE_URL,
      APP_MODE: 'beta',
      APP_HOST: '127.0.0.1',
      APP_ORIGIN: 'http://localhost:3004',
      PORT: '3004',
      APP_PREVIEW_MODE: 'false',
      IDENTITY_PHONE_DEMO_ENABLED: 'false',
      NATURAL_OWNER_PILOT_ENABLED: 'true',
      NATURAL_OWNER_PILOT_LOCAL: 'true',
      NATURAL_OWNER_PILOT_AMOUNT_MINOR: '100',
      NATURAL_PRODUCTION_AGENT_KEY: configuration.NATURAL_PRODUCTION_AGENT_KEY,
      NATURAL_OWNER_PILOT_PHONE_HASH: configuration.NATURAL_OWNER_PILOT_PHONE_HASH,
      NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: configuration.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE,
      NATURAL_PRODUCTION_API_KEY: '',
      NATURAL_AGENT_KEY: '',
      NATURAL_PRODUCTION_CONNECT_ENABLED: 'false',
      NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'false',
      NATURAL_SANDBOX_ENABLED: 'false',
      NATURAL_RECONCILIATION_ENABLED: 'false',
      NATURAL_SANDBOX_WEBHOOK_ENABLED: 'false',
      OPENAI_API_KEY: '',
      AWS_SECRET_ACCESS_KEY: '',
      SENDBLUE_FROM_NUMBER: '',
      MESSAGING_SEND_ENABLED: 'false',
      RECEIPTS_ENABLED: 'false',
      BETTER_AUTH_SECRET: configuration.BETTER_AUTH_SECRET,
      IDENTITY_ENCRYPTION_KEY: configuration.IDENTITY_ENCRYPTION_KEY,
      SENDBLUE_API_KEY_ID: configuration.SENDBLUE_API_KEY_ID,
      SENDBLUE_API_SECRET_KEY: configuration.SENDBLUE_API_SECRET_KEY,
      SENDBLUE_VERIFY_SERVICE_SID: configuration.SENDBLUE_VERIFY_SERVICE_SID,
      __NEXT_PROCESSED_ENV: 'true',
    });
    for (const key of [
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'RENDER',
      'HTTP_PROXY',
      'UNKNOWN_SECRET',
    ])
      expect(environment).not.toHaveProperty(key);
  });

  it('gives the reconciliation worker no identity, verification, platform-key or message credentials', () => {
    const worker = localOwnerPilotConfiguration('worker', configuration, {});
    expect(worker.command.at(-1)).toMatch(/scripts\/owner-pilot-worker.ts$/);
    expect(worker.environment).toMatchObject({
      DATABASE_URL: configuration.DATABASE_URL,
      NATURAL_PRODUCTION_AGENT_KEY: configuration.NATURAL_PRODUCTION_AGENT_KEY,
      NATURAL_OWNER_PILOT_WALLET_ID: configuration.NATURAL_OWNER_PILOT_WALLET_ID,
      NATURAL_OWNER_PILOT_PHONE_HASH: configuration.NATURAL_OWNER_PILOT_PHONE_HASH,
      NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: configuration.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE,
    });
    for (const key of [
      'BETTER_AUTH_SECRET',
      'IDENTITY_ENCRYPTION_KEY',
      'SENDBLUE_API_KEY_ID',
      'SENDBLUE_API_SECRET_KEY',
      'SENDBLUE_VERIFY_SERVICE_SID',
      'NATURAL_PRODUCTION_API_KEY',
      'NATURAL_PRODUCTION_WEBHOOK_SECRET',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
    ])
      expect(worker.environment).not.toHaveProperty(key);
    const migration = localOwnerPilotConfiguration('migrate', configuration, {
      PATH: '/bin',
      HOME: '/fixture/home',
      NODE_OPTIONS: '--untrusted',
    });
    expect(migration.command.at(-1)).toMatch(/packages\/db\/src\/migrate.ts$/);
    expect(migration.environment).toEqual({
      PATH: '/bin',
      HOME: '/fixture/home',
      NODE_ENV: 'production',
      DATABASE_URL: configuration.DATABASE_URL,
    });
  });

  it('prevents the installed Next env loader from adding root or app dotenv configuration', () => {
    const root = directory();
    const app = join(root, 'app');
    mkdirSync(app);
    writeFileSync(
      join(root, '.env'),
      'ROOT_ONLY_SECRET=private-root-fixture\nNATURAL_PRODUCTION_API_KEY=sk_ntl_prod_root\n',
    );
    writeFileSync(
      join(app, '.env.local'),
      'UNEXPECTED_NEW_PROVIDER_SECRET=private-app-fixture\nNATURAL_PRODUCTION_API_KEY=sk_ntl_prod_app\nNATURAL_OWNER_PILOT_AMOUNT_MINOR=100000\n',
    );
    const nextEnv = createRequire(import.meta.url).resolve('@next/env');
    const { environment } = localOwnerPilotConfiguration('web', configuration, {});
    for (const envDirectory of [root, app]) {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { createRequire } from 'node:module';
      const loader = createRequire(import.meta.url)(process.argv[1]);
      loader.loadEnvConfig(process.argv[2], false);
      const valid = process.env.ROOT_ONLY_SECRET === undefined &&
        process.env.UNEXPECTED_NEW_PROVIDER_SECRET === undefined &&
        process.env.NATURAL_PRODUCTION_API_KEY === '' &&
        process.env.NATURAL_OWNER_PILOT_AMOUNT_MINOR === '100';
      process.exit(valid ? 0 : 1);
    `,
          nextEnv,
          envDirectory,
        ],
        { cwd: root, env: environment, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
    }
  });

  it.each([
    'postgresql://fixture:fixture@hosted.example/tallie_owner_pilot',
    'postgresql://fixture:fixture@127.0.0.1/tallie',
    'postgresql://fixture:fixture@127.0.0.1/tallie_production_connect',
    'postgresql://fixture:fixture@127.0.0.1/tallie_owner_pilot?options=-csearch_path=other',
    'postgresql://fixture:fixture@127.0.0.1/tallie_owner_pilot#ignored',
    'postgresql://fixture:fixture@127.0.0.1/tallie_owner_pilot/',
    'postgresql://fixture:fixture@localhost.example/tallie_owner_pilot',
    'https://127.0.0.1/tallie_owner_pilot',
    '',
  ])('rejects remote, shared or redirected database settings', (DATABASE_URL) => {
    expect(() =>
      localOwnerPilotConfiguration('check', { ...configuration, DATABASE_URL }, {}),
    ).toThrow();
  });

  it.each(['127.0.0.1', 'localhost', '[::1]'])(
    'accepts the dedicated database on loopback %s',
    (host) => {
      expect(() =>
        localOwnerPilotConfiguration(
          'check',
          {
            ...configuration,
            DATABASE_URL: `postgresql://fixture:fixture@${host}/tallie_owner_pilot`,
          },
          {},
        ),
      ).not.toThrow();
    },
  );

  it.each([
    { APP_MODE: 'demo' },
    { APP_ORIGIN: 'https://public.example' },
    { APP_ORIGIN: 'http://localhost:3001' },
    { APP_HOST: '0.0.0.0' },
    { PORT: '3001' },
    { APP_PREVIEW_MODE: 'true' },
    { IDENTITY_PHONE_DEMO_ENABLED: 'true' },
    { NATURAL_OWNER_PILOT_ENABLED: 'false' },
    { NATURAL_OWNER_PILOT_LOCAL: 'false' },
    { NATURAL_OWNER_PILOT_AMOUNT_MINOR: '101' },
    { NATURAL_SANDBOX_ENABLED: 'true' },
    { NATURAL_RECONCILIATION_ENABLED: 'true' },
    { NATURAL_SANDBOX_WEBHOOK_ENABLED: 'true' },
    { NATURAL_PRODUCTION_CONNECT_ENABLED: 'true' },
    { NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true' },
    { RECEIPTS_ENABLED: 'true' },
    { MESSAGING_SEND_ENABLED: 'true' },
    { NATURAL_PRODUCTION_API_KEY: 'sk_ntl_prod_forbidden' },
    { NATURAL_PRODUCTION_AGENT_KEY: 'ak_ntl_sandbox_wrong' },
    { NATURAL_OWNER_PILOT_WALLET_ID: '' },
    { NATURAL_PRODUCTION_AGENT_ID: 'agt_wrong' },
    { NATURAL_PRODUCTION_PLATFORM_PARTY_ID: '' },
    { NATURAL_OWNER_PILOT_PHONE_HASH: 'raw-phone-number' },
    { NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: 'recipient' },
    { NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: '@recipient name' },
    { BETTER_AUTH_SECRET: 'short' },
    { IDENTITY_ENCRYPTION_KEY: '' },
    { SENDBLUE_API_KEY_ID: '' },
    { SENDBLUE_API_SECRET_KEY: '' },
    { SENDBLUE_VERIFY_SERVICE_SID: '' },
    { OPENAI_API_KEY: 'unrelated-secret' },
    { NODE_OPTIONS: '--untrusted' },
  ])('fails closed for expanded capabilities or incomplete setup: %j', (patch) => {
    expect(() =>
      localOwnerPilotConfiguration('check', { ...configuration, ...patch }, {}),
    ).toThrow();
  });

  it('permits exact fixed boundary values and rejects unsupported roles', () => {
    expect(() =>
      localOwnerPilotConfiguration(
        'check',
        {
          ...configuration,
          APP_ORIGIN: 'http://localhost:3004',
          NATURAL_OWNER_PILOT_AMOUNT_MINOR: '100',
          NATURAL_OWNER_PILOT_LOCAL: 'true',
        },
        {},
      ),
    ).not.toThrow();
    for (const role of ['web-preview', 'web-dev', 'receipt-worker', 'messaging-worker', ''])
      expect(() => localOwnerPilotConfiguration(role, configuration, {})).toThrow();
  });

  it('reads current-user-only regular files and rejects public files, links, oversized files and missing paths', () => {
    const root = directory();
    const file = join(root, 'owner.env');
    writeFileSync(file, 'NATURAL_OWNER_PILOT_RECIPIENT_HANDLE=@recipient\n', { mode: 0o600 });
    expect(readLocalOwnerPilotSettings(file)).toEqual({
      NATURAL_OWNER_PILOT_RECIPIENT_HANDLE: '@recipient',
    });
    chmodSync(file, 0o644);
    expect(() => readLocalOwnerPilotSettings(file)).toThrow('current-user-only');
    chmodSync(file, 0o600);
    const link = join(root, 'link.env');
    symlinkSync(file, link);
    expect(() => readLocalOwnerPilotSettings(link)).toThrow('current-user-only');
    expect(() => readLocalOwnerPilotSettings(root)).toThrow('current-user-only');
    expect(() => readLocalOwnerPilotSettings(join(root, 'missing-private-name.env'))).toThrow(
      'current-user-only',
    );
    writeFileSync(file, 'x'.repeat(65_537));
    expect(() => readLocalOwnerPilotSettings(file)).toThrow('current-user-only');
  });
});
