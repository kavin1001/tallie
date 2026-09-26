import type { Kysely } from 'kysely';
import type { Database } from './schema';

/** No provider access or encryption key is required to erase expired development evidence. */
export async function expirePhoneVerificationChallenges(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  const result = await db
    .updateTable('phone_verification_challenges')
    .set({ status: 'expired', phone_ciphertext: null, delivery_ciphertext: null })
    .where('status', 'in', ['creating', 'pending'])
    .where('expires_at', '<=', now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
