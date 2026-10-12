import { readOwnerPilotRuntimeConfig } from '@tallie/app-services/owner-pilot';
import {
  identityDatabase,
  normalizePhone,
  verifiedPhoneFor,
  type AccountPrincipal,
} from '@tallie/identity';
import { NaturalOwnerPilotClient } from '@tallie/natural';
import { OwnerPilotService, type PaymentDatabase } from '@tallie/payments';
import type { Kysely } from 'kysely';
import { AppError } from '../errors';

export function ownerPilotAvailable() {
  return readOwnerPilotRuntimeConfig(process.env) !== null;
}

export function ownerPilotService(actor: AccountPrincipal) {
  const config = readOwnerPilotRuntimeConfig(process.env);
  if (!config)
    throw new AppError(
      'OWNER_PILOT_DISABLED',
      'Personal payment testing is unavailable here.',
      503,
    );
  if (actor.phoneHash !== config.ownerPhoneHash)
    throw new AppError(
      'OWNER_PILOT_NOT_AUTHORIZED',
      'This personal test is only available to the configured wallet owner.',
      403,
    );
  const client = new NaturalOwnerPilotClient(config.provider);
  return new OwnerPilotService(
    identityDatabase() as unknown as Kysely<PaymentDatabase>,
    {
      async getOwnerWallet() {
        const [wallet, phone] = await Promise.all([
          client.getOwnerWallet(),
          verifiedPhoneFor(actor.userId),
        ]);
        if (
          !wallet.primaryPhone ||
          !phone ||
          normalizePhone(wallet.primaryPhone) !== normalizePhone(phone)
        )
          throw new AppError(
            'OWNER_PILOT_NOT_AUTHORIZED',
            'Your verified phone must match the phone on your Natural account.',
            403,
          );
        return wallet;
      },
      send: (input) => client.send(input),
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
      ownerAccountId: actor.userId,
    },
  );
}
