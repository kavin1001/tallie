import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { serviceConfiguration } from './run-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const settingsPath = resolve(root, '.tallie/production-connect.env');
const inputKeys = new Set([
  'APP_ORIGIN',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'IDENTITY_ENCRYPTION_KEY',
  'SENDBLUE_API_KEY_ID',
  'SENDBLUE_API_SECRET_KEY',
  'SENDBLUE_VERIFY_SERVICE_SID',
  'NATURAL_PRODUCTION_API_KEY',
  'NATURAL_PRODUCTION_AGENT_KEY',
  'NATURAL_PRODUCTION_AGENT_ID',
  'NATURAL_PRODUCTION_PLATFORM_PARTY_ID',
  'NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR',
  'NATURAL_PRODUCTION_WEBHOOK_SECRET',
  'NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET',
]);
const fixedSettings = {
  APP_MODE: 'beta',
  APP_HOST: '127.0.0.1',
  PORT: '3003',
  APP_PREVIEW_MODE: 'false',
  IDENTITY_PHONE_DEMO_ENABLED: 'false',
  NATURAL_SANDBOX_ENABLED: 'false',
  NATURAL_RECONCILIATION_ENABLED: 'false',
  NATURAL_SANDBOX_WEBHOOK_ENABLED: 'false',
  NATURAL_PRODUCTION_CONNECT_ENABLED: 'true',
  NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
  RECEIPTS_ENABLED: 'false',
  MESSAGING_SEND_ENABLED: 'false',
};
const systemKeys = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']);
function signingSecretValid(secret = '') {
  const encoded = secret.slice(6);
  return (
    secret.startsWith('whsec_') &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) &&
    encoded.length <= 256 &&
    Buffer.from(encoded, 'base64').length >= 32 &&
    Buffer.from(encoded, 'base64').toString('base64') === encoded
  );
}

/** Dedicated connection setup runtime; never merges the root .env or caller credentials. */
export function localConnectionConfiguration(role, config, platform = process.env) {
  if (!['check', 'migrate', 'web', 'worker'].includes(role))
    throw new Error('Choose check, migrate, web, or worker.');
  for (const [key, value] of Object.entries(config)) {
    if (Object.hasOwn(fixedSettings, key)) {
      if (value !== fixedSettings[key]) throw new Error('Connection setup boundaries are fixed.');
    } else if (!inputKeys.has(key)) {
      throw new Error('Unexpected connection setup setting.');
    }
  }
  const origin = new URL(config.APP_ORIGIN ?? '');
  if (
    origin.origin !== config.APP_ORIGIN ||
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.port ||
    !origin.hostname.includes('.') ||
    origin.hostname === 'localhost' ||
    origin.hostname.endsWith('.localhost') ||
    /^[0-9.]+$/.test(origin.hostname)
  )
    throw new Error('A fixed public HTTPS origin is required.');
  const database = new URL(config.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
    database.pathname !== '/tallie_production_connect' ||
    database.search ||
    database.hash
  )
    throw new Error('Use the dedicated local connection database.');
  if (
    (config.BETTER_AUTH_SECRET?.length ?? 0) < 32 ||
    !/^[0-9a-fA-F]{64}$/.test(config.IDENTITY_ENCRYPTION_KEY ?? '') ||
    !config.SENDBLUE_API_KEY_ID ||
    !config.SENDBLUE_API_SECRET_KEY ||
    !/^SV[A-Za-z0-9]{20,64}$/.test(config.SENDBLUE_VERIFY_SERVICE_SID ?? '') ||
    !signingSecretValid(config.NATURAL_PRODUCTION_WEBHOOK_SECRET) ||
    (config.NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET &&
      !signingSecretValid(config.NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET))
  )
    throw new Error('Complete production connection and identity settings are required.');
  const safePlatform = Object.fromEntries(
    Object.entries(platform).filter(([key]) => systemKeys.has(key)),
  );
  const settings = { ...config, ...fixedSettings };
  // Validate both roles, even for a dry check or migration, before any child is started.
  const web = serviceConfiguration('web-start', settings, safePlatform);
  const worker = serviceConfiguration('core-worker', settings, safePlatform);
  const specification = role === 'worker' ? worker : web;
  specification.environment = {
    ...specification.environment,
    ...fixedSettings,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    // Next also reads apps/web/.env.local. Explicit empty values prevent unexpected
    // local provider/storage credentials from being added to this isolated runtime.
    OPENAI_API_KEY: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_SESSION_TOKEN: '',
    NATURAL_API_KEY: '',
    NATURAL_PROVISIONING_API_KEY: '',
    NATURAL_AGENT_KEY: '',
    NATURAL_AGENT_ID: '',
    NATURAL_PLATFORM_PARTY_ID: '',
    NATURAL_ENVIRONMENT: '',
    NATURAL_SANDBOX_WEBHOOK_SECRET: '',
    NATURAL_SANDBOX_WEBHOOK_PREVIOUS_SECRET: '',
    SENDBLUE_FROM_NUMBER: '',
    SENDBLUE_MESSAGE_WEBHOOK_SECRET: '',
    SENDBLUE_PHONE_ENCRYPTION_KEY: '',
    MESSAGING_ENCRYPTION_KEY: '',
    RECEIPT_STORAGE_DRIVER: '',
    RECEIPTS_BUCKET: '',
    RECEIPTS_BUCKET_OWNER: '',
  };
  if (role === 'migrate') {
    specification.command = [
      resolve(root, 'node_modules/tsx/dist/cli.mjs'),
      resolve(root, 'packages/db/src/migrate.ts'),
    ];
    specification.cwd = root;
    specification.environment = {
      ...safePlatform,
      NODE_ENV: 'production',
      DATABASE_URL: settings.DATABASE_URL,
    };
  }
  return specification;
}

export function readLocalConnectionSettings(path = settingsPath) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new Error('Connection settings must be an owner-only regular file.');
  return parse(readFileSync(path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('A single connection setup role is required.');
    const role = process.argv[2];
    const specification = localConnectionConfiguration(role, readLocalConnectionSettings());
    if (role === 'check') {
      console.info(
        'Connection setup configuration valid: dedicated local database, port 3003, HTTPS, passkeys required, money movement unavailable.',
      );
    } else {
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
        console.error('Connection setup process could not start. Check dependencies and build.');
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
      'Connection setup configuration is invalid. Check .tallie/production-connect.env, its owner-only permissions, and the selected role.',
    );
    process.exitCode = 1;
  }
}
