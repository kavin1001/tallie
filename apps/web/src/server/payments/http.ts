import { SandboxOnboardingError } from '@tallie/payments';
import { z } from 'zod';
import { accountRoute } from '../account-http';
import { AppError } from '../errors';
import { requireAccount } from '../identity';
import { jsonResponse, readJson } from '../http';
import { sandboxPaymentsService } from './service';

export function sandboxRoute(action: 'state' | 'start' | 'retry' | 'refresh') {
  return accountRoute(async (request) => {
    const actor = await requireAccount(request);
    if (action !== 'state') await readJson(request, z.strictObject({}));
    try {
      return jsonResponse(await sandboxPaymentsService()[action](actor));
    } catch (error) {
      if (error instanceof SandboxOnboardingError)
        throw new AppError(error.code, error.message, error.status);
      throw error;
    }
  });
}
