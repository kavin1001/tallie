import { ProductionConnectionError, type ProductionConnectionState } from '@tallie/payments';
import { z } from 'zod';
import { accountRoute } from '../account-http';
import { AppError } from '../errors';
import { jsonResponse, readJson } from '../http';
import { requireAccount, requireRecentAccount } from '../identity';
import {
  productionConnectionService,
  readProductionConnectionConfiguration,
} from './production-connection';

const messages: Readonly<Record<string, string>> = {
  RECENT_PASSKEY_REQUIRED: 'Use your passkey again before setting up payments.',
  CONNECTION_UNAVAILABLE: 'Payment account setup is not available yet.',
  CONNECTION_BINDING_CHANGED:
    'Your account details changed. Contact Tallie before continuing setup.',
  PHONE_BINDING_CHANGED: 'Verify your current phone number before continuing setup.',
  INVITATION_BINDING_MISMATCH: 'This setup link could not be verified. Contact Tallie for help.',
  INVITATION_EXPIRED: 'This setup link has expired. Contact Tallie for a new invitation.',
};
export function productionConnectionRoute(action: 'state' | 'start' | 'return' | 'refresh') {
  return accountRoute(async (request) => {
    const actor =
      action === 'start' ? await requireRecentAccount(request) : await requireAccount(request);
    const config = readProductionConnectionConfiguration();
    if (!config) {
      if (action === 'state')
        return jsonResponse({
          available: false,
          environment: 'production',
          moneyMovementEnabled: false,
          connection: null,
        } satisfies ProductionConnectionState);
      throw new AppError('CONNECTION_UNAVAILABLE', messages.CONNECTION_UNAVAILABLE!, 503);
    }
    try {
      if (action === 'start') {
        await readJson(request, z.strictObject({}));
        return jsonResponse(await productionConnectionService().start(actor));
      }
      if (action === 'refresh') {
        await readJson(request, z.strictObject({}));
        return jsonResponse(await productionConnectionService().refresh(actor));
      }
      if (action === 'return') {
        const input = await readJson(
          request,
          z.strictObject({ state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) }),
        );
        const matches = await productionConnectionService().matchReturn(actor, input.state);
        if (!matches)
          throw new AppError(
            'INVALID_RETURN_STATE',
            'This setup link does not belong to your signed-in account.',
            400,
          );
        return jsonResponse({ matched: true, moneyMovementEnabled: false });
      }
      return jsonResponse(await productionConnectionService().state(actor));
    } catch (error) {
      if (error instanceof ProductionConnectionError)
        throw new AppError(
          error.code,
          messages[error.code] ?? 'Account setup needs attention. Contact Tallie for help.',
          error.status,
        );
      throw error;
    }
  });
}
