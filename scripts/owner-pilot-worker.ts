import { setTimeout as delay } from 'node:timers/promises';
import { readOwnerPilotRuntimeConfig } from '@tallie/app-services/owner-pilot';
import { createIdentityDatabase } from '@tallie/identity';
import { NaturalOwnerPilotClient } from '@tallie/natural';
import { OwnerPilotService, type PaymentDatabase } from '@tallie/payments';
import type { Kysely } from 'kysely';

// This worker has no submission path. It only reconciles the one saved operation.
const config = readOwnerPilotRuntimeConfig(process.env);
if (!config) throw new Error('The dedicated local owner pilot must be enabled.');
const db = createIdentityDatabase(process.env.DATABASE_URL!);
const client = new NaturalOwnerPilotClient(config.provider);
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
console.info('Owner pilot status worker started; automatic payment submission is unavailable.');
try {
  while (!stop.signal.aborted) {
    try {
      const owner = await db
        .selectFrom('identity_phone_bindings')
        .select('user_id')
        .where('phone_hash', '=', config.ownerPhoneHash)
        .executeTakeFirst();
      if (owner) {
        const service = new OwnerPilotService(
          db as unknown as Kysely<PaymentDatabase>,
          {
            getOwnerWallet: () => client.getOwnerWallet(),
            send: async () => {
              throw new Error('Worker submission is unavailable.');
            },
            getPayment: (id) => client.getPayment(id),
            findPayment: (operationId) => client.findPayment(operationId),
          },
          {
            enabled: config.enabled,
            ownerPhoneHash: config.ownerPhoneHash,
            recipientHandle: config.recipientHandle,
            maxAmountMinor: config.maxAmountMinor,
            platformPartyId: config.provider.platformPartyId,
            agentId: config.provider.agentId,
            walletId: config.provider.walletId,
            ownerAccountId: owner.user_id,
          },
        );
        await service.reconcile();
      }
    } catch {
      console.error('Owner pilot status check interrupted; saved payment remains unchanged.');
    }
    await delay(15_000, undefined, { signal: stop.signal }).catch(() => undefined);
  }
} finally {
  await db.destroy();
}
