import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = {
  'web-dev': ['node_modules/next/dist/bin/next', 'dev'],
  'web-start': ['node_modules/next/dist/bin/next', 'start'],
  'web-preview': ['node_modules/tsx/dist/cli.mjs', 'scripts/start-preview.ts'],
  'core-worker': ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/index.ts'],
  'receipt-worker': ['node_modules/tsx/dist/cli.mjs', 'apps/receipt-worker/src/index.ts'],
  'messaging-worker': ['node_modules/tsx/dist/cli.mjs', 'apps/messaging-worker/src/index.ts'],
};

/** Platform environment is trusted configuration; forwarded request headers are never consulted. */
export function appOrigin(config, platform = process.env) {
  if (config.APP_ORIGIN) {
    const explicit = new URL(config.APP_ORIGIN);
    if (
      explicit.origin !== config.APP_ORIGIN ||
      explicit.username ||
      explicit.password ||
      !(
        explicit.protocol === 'https:' ||
        (explicit.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(explicit.hostname))
      )
    )
      throw new Error('APP_ORIGIN must be a fixed HTTPS origin or a local development origin.');
    return explicit.origin;
  }
  if (platform.RENDER !== 'true' || !platform.RENDER_EXTERNAL_URL) return undefined;
  let url;
  try {
    url = new URL(platform.RENDER_EXTERNAL_URL);
  } catch {
    throw new Error('Render must supply a valid public HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith('.onrender.com')
  )
    throw new Error('Render must supply a valid public HTTPS origin.');
  return url.origin;
}

/** Exported for launch verification; returned secrets must never be printed. */
export function serviceConfiguration(service, config, platform = process.env) {
  const definition = commands[service];
  if (!definition) throw new Error(`Choose one of: ${Object.keys(commands).join(', ')}.`);
  const command = [...definition];
  const preview = service === 'web-preview';
  if (preview && config.APP_MODE !== 'beta')
    throw new Error('The free preview requires APP_MODE=beta.');
  if (preview && (config.RECEIPTS_ENABLED === 'true' || config.MESSAGING_SEND_ENABLED === 'true'))
    throw new Error('Receipt processing and message delivery are unavailable in the free preview.');

  const environment = Object.fromEntries(
    Object.entries(platform).filter(
      ([key]) =>
        !/^(OPENAI_|SENDBLUE_|TWILIO_|NATURAL_|RECEIPT|DATABASE_URL|APP_|BETTER_AUTH_|IDENTITY_|MESSAGING_|AWS_)/.test(
          key,
        ),
    ),
  );
  const allowed = ['DATABASE_URL', 'APP_MODE'];
  if (service.startsWith('web-') || service === 'messaging-worker')
    allowed.push('SENDBLUE_API_KEY_ID', 'SENDBLUE_API_SECRET_KEY', 'IDENTITY_ENCRYPTION_KEY');
  if (!preview && (service.startsWith('web-') || service === 'messaging-worker'))
    allowed.push(
      'SENDBLUE_FROM_NUMBER',
      'MESSAGING_ENCRYPTION_KEY',
      'MESSAGING_SEND_ENABLED',
      'SENDBLUE_MESSAGE_WEBHOOK_SECRET',
    );
  if (service.startsWith('web-')) allowed.push('BETTER_AUTH_SECRET', 'SENDBLUE_VERIFY_SERVICE_SID');
  if (!preview && service.startsWith('web-')) allowed.push('SENDBLUE_PHONE_ENCRYPTION_KEY');
  if (service === 'receipt-worker') allowed.push('OPENAI_API_KEY');
  if (!preview && service !== 'core-worker')
    allowed.push(
      'RECEIPT_STORAGE_DRIVER',
      'RECEIPTS_BUCKET',
      'RECEIPTS_BUCKET_OWNER',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    );
  for (const key of allowed) if (config[key]) environment[key] = config[key];
  const origin = appOrigin(config, platform);
  if (origin) environment.APP_ORIGIN = origin;
  if (preview) {
    if (!origin || !environment.DATABASE_URL)
      throw new Error('The free preview requires DATABASE_URL and a fixed public origin.');
    environment.RECEIPTS_ENABLED = 'false';
    environment.MESSAGING_SEND_ENABLED = 'false';
    environment.APP_HOST = config.APP_HOST || '0.0.0.0';
  } else if (service !== 'core-worker') {
    environment.RECEIPTS_ENABLED =
      config.RECEIPTS_ENABLED ?? (config.OPENAI_API_KEY ? 'true' : 'false');
    environment.RECEIPT_MODEL = config.RECEIPT_MODEL || 'gpt-4.1-mini-2025-04-14';
    environment.RECEIPT_STORAGE_DIR =
      config.RECEIPT_STORAGE_DIR || resolve(root, '.tallie/receipts');
  }
  if (service === 'web-dev' || service === 'web-start')
    command.push('--hostname', config.APP_HOST || '127.0.0.1');
  return {
    command: [resolve(root, command[0]), ...command.slice(1)],
    cwd: service === 'web-dev' || service === 'web-start' ? resolve(root, 'apps/web') : root,
    environment,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fileConfig = {};
  try {
    fileConfig = parse(readFileSync(resolve(root, '.env')));
  } catch {
    // Hosted environments supply their configuration without a local file.
  }
  try {
    const service = process.argv[2];
    const specification = serviceConfiguration(service, { ...fileConfig, ...process.env });
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
      console.error(`Unable to start ${service}. Run npm ci and check configuration.`);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.exitCode = code ?? (signal ? 0 : 1);
    });
  } catch {
    console.error(
      'Service configuration is invalid. Check the selected role and required settings.',
    );
    process.exitCode = 1;
  }
}
