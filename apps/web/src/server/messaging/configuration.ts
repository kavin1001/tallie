import { identityDatabase } from '@tallie/identity';
import {
  MessagingError,
  configuredMessagingService,
  type MessagingDatabase,
  type MessagingService,
} from '@tallie/messaging';
import type { Kysely } from 'kysely';
export { messagingConfigured, configuredMessagingService } from '@tallie/messaging';

let ingress: MessagingService | undefined;
export function messagingIngress(): MessagingService {
  if (!process.env.DATABASE_URL) throw new MessagingError('MESSAGING_NOT_CONFIGURED', 503);
  // This entrypoint only records authenticated inbox events. It cannot process
  // commands or send messages; the worker supplies actual identity/social hooks.
  return (ingress ??= configuredMessagingService(
    identityDatabase() as unknown as Kysely<MessagingDatabase>,
    {
      validateIdentity: async () => false,
      resolveContacts: async (_identity, names) => ({ participants: [], unresolvedNames: names }),
    },
  ));
}
