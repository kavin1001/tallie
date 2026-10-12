import { NaturalProviderError } from '@tallie/natural';
import { OwnerPilotError } from '@tallie/payments';
import { z } from 'zod';
import { accountRoute } from '../account-http';
import { AppError } from '../errors';
import { jsonResponse, readJson } from '../http';
import { requireAccount } from '../identity';
import { ownerPilotService } from './owner-pilot';

const messages: Readonly<Record<string, string>> = {
  OWNER_PILOT_PASSKEY_REQUIRED: 'Confirm with your passkey to review this payment.',
  OWNER_PILOT_NOT_AUTHORIZED:
    'This personal test is only available to the configured wallet owner.',
  OWNER_PILOT_INSUFFICIENT_BALANCE: 'Your Natural wallet does not have enough available funds.',
  OWNER_PILOT_REVIEW_EXPIRED: 'This review expired. Review the payment again.',
  OWNER_PILOT_BINDING_CHANGED:
    'The saved payment details changed. Please contact Tallie before continuing.',
};
export function ownerPilotRoute(action: 'state' | 'review' | 'confirm' | 'refresh') {
  return accountRoute(async (request) => {
    const actor = await requireAccount(request);
    const input =
      action === 'state'
        ? null
        : action === 'confirm'
          ? await readJson(request, z.strictObject({ reviewId: z.uuid() }))
          : await readJson(request, z.strictObject({}));
    try {
      const service = ownerPilotService(actor);
      if (action === 'confirm')
        return jsonResponse(await service.confirm(actor, (input as { reviewId: string }).reviewId));
      return jsonResponse(await service[action](actor));
    } catch (error) {
      if (error instanceof OwnerPilotError)
        throw new AppError(
          error.code,
          messages[error.code] ??
            'Check the saved payment status before continuing. This action cannot create a replacement payment.',
          error.status,
        );
      if (error instanceof NaturalProviderError)
        throw new AppError(
          'OWNER_PILOT_PROVIDER_UNAVAILABLE',
          'Natural could not be reached or verified. Check the saved status before continuing.',
          503,
        );
      throw error;
    }
  });
}
