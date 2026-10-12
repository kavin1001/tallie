import { SandboxOnboardingError, SandboxSendError } from '@tallie/payments';
import { z } from 'zod';
import { accountRoute } from '../account-http';
import { AppError } from '../errors';
import { idempotencyKey, jsonResponse, readJson } from '../http';
import { requireAccount } from '../identity';
import { sandboxSendService } from './send-service';

const emptyBody = z.strictObject({});
const confirmBody = z.strictObject({ reviewId: z.uuid() });
type ShareRouteContext = { params: Promise<{ shareId: string }> };

/** Share amount, recipient and payment authority are resolved by the account service. */
export function sandboxShareRoute(action: 'state' | 'review' | 'confirm') {
  return (request: Request, context: ShareRouteContext): Promise<Response> =>
    accountRoute(async (req) => {
      const actor = await requireAccount(req);
      const shareId = z.uuid().parse((await context.params).shareId);
      const service = sandboxSendService();
      try {
        if (action === 'state') return jsonResponse(await service.shareState(actor, shareId));
        if (action === 'review') {
          await readJson(req, emptyBody);
          const key = z.uuid().safeParse(idempotencyKey(req));
          if (!key.success)
            throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Retry this review with the same key.');
          return jsonResponse(await service.reviewShare(actor, { shareId }, key.data));
        }
        const body = await readJson(req, confirmBody);
        // The service checks the review's share binding before any payment dispatch.
        return jsonResponse(
          await service.confirmShare(actor, { shareId, reviewId: body.reviewId }),
        );
      } catch (error) {
        if (error instanceof SandboxOnboardingError || error instanceof SandboxSendError)
          throw new AppError(error.code, error.message, error.status);
        throw error;
      }
    })(request);
}
