import { readOwnerPilotConfig } from '@tallie/natural';

/** This exception is deliberately unavailable in every normal deployment role. */
export function readOwnerPilotRuntimeConfig(env: Readonly<Record<string, string | undefined>>) {
  if (env.NATURAL_OWNER_PILOT_ENABLED !== 'true') return null;
  const database = new URL(env.DATABASE_URL ?? '');
  if (
    env.NATURAL_OWNER_PILOT_LOCAL !== 'true' ||
    env.APP_ORIGIN !== 'http://localhost:3004' ||
    env.APP_HOST !== '127.0.0.1' ||
    env.PORT !== '3004' ||
    env.APP_MODE !== 'beta' ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
    database.pathname !== '/tallie_owner_pilot' ||
    database.search ||
    database.hash ||
    !/^[0-9a-f]{64}$/.test(env.NATURAL_OWNER_PILOT_PHONE_HASH ?? '') ||
    !/^@[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(env.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE ?? '') ||
    [
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
    ].some((key) => env[key] === 'true')
  )
    throw new Error('Owner pilot requires its dedicated local runtime.');
  return {
    provider: readOwnerPilotConfig(env),
    ownerPhoneHash: env.NATURAL_OWNER_PILOT_PHONE_HASH!,
    recipientHandle: env.NATURAL_OWNER_PILOT_RECIPIENT_HANDLE!,
    maxAmountMinor: 100,
    enabled: true,
  } as const;
}
