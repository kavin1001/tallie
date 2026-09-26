import type { Kysely } from 'kysely';
import { MessagingError, type MessagingHooks } from './contracts';
import type { MessagingDatabase } from './schema';
import { MessagingService, providerAccountFingerprint } from './service';
import { SendblueMessagingTransport } from './transport';

export function messagingConfigured(): boolean {
  return !!(
    process.env.SENDBLUE_API_KEY_ID &&
    process.env.SENDBLUE_API_SECRET_KEY &&
    /^\+1[2-9]\d{9}$/.test(process.env.SENDBLUE_FROM_NUMBER ?? '') &&
    /^[a-f0-9]{64}$/i.test(process.env.MESSAGING_ENCRYPTION_KEY ?? '') &&
    process.env.APP_ORIGIN
  );
}

export function configuredMessagingService(
  db: Kysely<MessagingDatabase>,
  hooks: MessagingHooks,
): MessagingService {
  if (!messagingConfigured()) throw new MessagingError('MESSAGING_NOT_CONFIGURED', 503);
  return new MessagingService(
    db,
    new SendblueMessagingTransport(
      process.env.SENDBLUE_API_KEY_ID!,
      process.env.SENDBLUE_API_SECRET_KEY!,
      process.env.SENDBLUE_FROM_NUMBER!,
    ),
    hooks,
    {
      providerAccount: providerAccountFingerprint(process.env.SENDBLUE_API_KEY_ID!),
      sendingLine: process.env.SENDBLUE_FROM_NUMBER!,
      encryptionKey: process.env.MESSAGING_ENCRYPTION_KEY!,
      appOrigin: process.env.APP_ORIGIN!,
      sendingEnabled:
        process.env.MESSAGING_SEND_ENABLED === 'true' &&
        (process.env.SENDBLUE_MESSAGE_WEBHOOK_SECRET?.length ?? 0) >= 32 &&
        process.env.APP_ORIGIN!.startsWith('https://'),
    },
  );
}
