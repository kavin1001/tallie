import { identityDatabase, identityVault } from '@tallie/identity';
import { SocialService, type SocialDatabase } from '@tallie/social';
import type { Kysely } from 'kysely';
import { sandboxPaymentsAvailable } from '../payments/configuration';

export function socialService(): SocialService {
  return new SocialService(
    identityDatabase() as unknown as Kysely<SocialDatabase>,
    identityVault(),
    process.env.APP_ORIGIN ?? '',
    undefined,
    process.env.RECEIPTS_ENABLED === 'true',
    sandboxPaymentsAvailable(),
  );
}
