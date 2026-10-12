import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const settingsPath = resolve(root, '.tallie/owner-pilot.env');
const providerKeys = [
  'NATURAL_PRODUCTION_AGENT_KEY',
  'NATURAL_PRODUCTION_AGENT_ID',
  'NATURAL_PRODUCTION_PLATFORM_PARTY_ID',
  'NATURAL_OWNER_PILOT_WALLET_ID',
  'NATURAL_OWNER_PILOT_PHONE_HASH',
  'NATURAL_OWNER_PILOT_RECIPIENT_HANDLE',
];
const identityKeys = [
  'BETTER_AUTH_SECRET',
  'IDENTITY_ENCRYPTION_KEY',
  'SENDBLUE_API_KEY_ID',
  'SENDBLUE_API_SECRET_KEY',
  'SENDBLUE_VERIFY_SERVICE_SID',
];
const inputKeys = new Set(['DATABASE_URL', ...identityKeys, ...providerKeys]);
const systemKeys = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']);
const fixedSettings = {
  APP_MODE: 'beta',
  APP_ORIGIN: 'http://localhost:3004',
  APP_HOST: '127.0.0.1',
  PORT: '3004',
  APP_PREVIEW_MODE: 'false',
  IDENTITY_PHONE_DEMO_ENABLED: 'false',
  NATURAL_OWNER_PILOT_ENABLED: 'true',
  NATURAL_OWNER_PILOT_LOCAL: 'true',
  NATURAL_OWNER_PILOT_AMOUNT_MINOR: '100',
  NATURAL_SANDBOX_ENABLED: 'false',
  NATURAL_RECONCILIATION_ENABLED: 'false',
  NATURAL_SANDBOX_WEBHOOK_ENABLED: 'false',
  NATURAL_PRODUCTION_CONNECT_ENABLED: 'false',
  NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'false',
  RECEIPTS_ENABLED: 'false',
  MESSAGING_SEND_ENABLED: 'false',
};
const blockedWebKeys = [
  'OPENAI_API_KEY',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'NATURAL_API_KEY',
  'NATURAL_PROVISIONING_API_KEY',
  'NATURAL_AGENT_KEY',
  'NATURAL_AGENT_ID',
  'NATURAL_PLATFORM_PARTY_ID',
  'NATURAL_ENVIRONMENT',
  'NATURAL_API_BASE_URL',
  'NATURAL_PRODUCTION_API_KEY',
  'NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR',
  'NATURAL_SANDBOX_WEBHOOK_SECRET',
  'NATURAL_SANDBOX_WEBHOOK_PREVIOUS_SECRET',
  'NATURAL_PRODUCTION_WEBHOOK_SECRET',
  'NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET',
  'SENDBLUE_FROM_NUMBER',
  'SENDBLUE_MESSAGE_WEBHOOK_SECRET',
  'SENDBLUE_PHONE_ENCRYPTION_KEY',
  'MESSAGING_ENCRYPTION_KEY',
  'RECEIPT_STORAGE_DRIVER',
  'RECEIPT_STORAGE_DIR',
  'RECEIPTS_BUCKET',
  'RECEIPTS_BUCKET_OWNER',
];

/** Validates the complete dedicated file before selecting a role. No file/env merging occurs. */
export function localOwnerPilotConfiguration(role, config, platform = process.env) {
  if (!['check', 'migrate', 'web', 'worker'].includes(role))
    throw new Error('Choose check, migrate, web, or worker.');
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') throw new Error('Owner pilot settings must be strings.');
    if (Object.hasOwn(fixedSettings, key)) {
      if (value !== fixedSettings[key]) throw new Error('Owner pilot boundaries are fixed.');
    } else if (!inputKeys.has(key)) throw new Error('Unexpected owner pilot setting.');
  }
  let database;
  try {
    database = new URL(config.DATABASE_URL ?? '');
  } catch {
    throw new Error('Use the dedicated local owner pilot database.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
    database.pathname !== '/tallie_owner_pilot' ||
    database.search ||
    database.hash
  )
    throw new Error('Use the dedicated local owner pilot database.');
  if (
    (config.BETTER_AUTH_SECRET?.length ?? 0) < 32 ||
    !/^[0-9a-fA-F]{64}$/.test(config.IDENTITY_ENCRYPTION_KEY ?? '') ||
    !config.SENDBLUE_API_KEY_ID ||
    !config.SENDBLUE_API_SECRET_KEY ||
    !/^SV[A-Za-z0-9]{20,64}$/.test(config.SENDBLUE_VERIFY_SERVICE_SID ?? '') ||
    !/^ak_ntl_prod_[A-Za-z0-9_-]{1,512}$/.test(config.NATURAL_PRODUCTION_AGENT_KEY ?? '') ||
    !/^agt_[0-9a-f]{32}$/.test(config.NATURAL_PRODUCTION_AGENT_ID ?? '') ||
    !/^pty_[0-9a-f]{32}$/.test(config.NATURAL_PRODUCTION_PLATFORM_PARTY_ID ?? '') ||
    !/^wal_[0-9a-f]{32}$/.test(config.NATURAL_OWNER_PILOT_WALLET_ID ?? '') ||
    !/^[0-9a-f]{64}$/.test(config.NATURAL_OWNER_PILOT_PHONE_HASH ?? '') ||
    !/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(config.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE ?? '')
  )
    throw new Error('Complete owner pilot and passkey identity settings are required.');

  const safePlatform = Object.fromEntries(
    Object.entries(platform).filter(
      ([key, value]) => systemKeys.has(key) && typeof value === 'string',
    ),
  );
  const migrationEnvironment = {
    ...safePlatform,
    NODE_ENV: 'production',
    DATABASE_URL: config.DATABASE_URL,
  };
  if (role === 'migrate')
    return {
      command: [
        resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        resolve(root, 'packages/db/src/migrate.ts'),
      ],
      cwd: root,
      environment: migrationEnvironment,
    };
  const environment = {
    ...migrationEnvironment,
    ...fixedSettings,
    ...Object.fromEntries(providerKeys.map((key) => [key, config[key]])),
  };
  if (role === 'worker')
    return {
      command: [
        resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        resolve(root, 'scripts/owner-pilot-worker.ts'),
      ],
      cwd: root,
      environment,
    };
  return {
    command: [
      resolve(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3004',
    ],
    cwd: resolve(root, 'apps/web'),
    environment: {
      ...environment,
      ...Object.fromEntries(identityKeys.map((key) => [key, config[key]])),
      ...Object.fromEntries(blockedWebKeys.map((key) => [key, ''])),
      NEXT_TELEMETRY_DISABLED: '1',
      // The pinned Next env loader respects this marker. Its behavior is exercised
      // with synthetic .env files in owner-pilot-runtime.test.ts. Explicit blanks
      // additionally protect known unrelated provider capabilities.
      __NEXT_PROCESSED_ENV: 'true',
    },
  };
}

export function readLocalOwnerPilotSettings(path = settingsPath) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      metadata.size > 65_536
    )
      throw new Error('Invalid owner pilot settings file.');
    return parse(readFileSync(descriptor));
  } catch {
    throw new Error('Owner pilot settings must be a current-user-only regular file.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('A single owner pilot role is required.');
    const role = process.argv[2];
    const specification = localOwnerPilotConfiguration(role, readLocalOwnerPilotSettings());
    if (role === 'check')
      console.info(
        'Owner pilot configuration valid: localhost:3004, dedicated local database, passkeys required, one explicitly approved $1 payment.',
      );
    else {
      const child = spawn(process.execPath, specification.command, {
        cwd: specification.cwd,
        env: specification.environment,
        stdio: 'inherit',
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      child.on('error', () => {
        console.error('Owner pilot process could not start. Check dependencies and build.');
        process.exitCode = 1;
      });
      child.on('exit', (code, signal) => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        process.exitCode = code ?? (signal ? 0 : 1);
      });
    }
  } catch {
    console.error(
      'Owner pilot configuration is invalid. Check .tallie/owner-pilot.env, its owner-only permissions, and the selected role.',
    );
    process.exitCode = 1;
  }
}
