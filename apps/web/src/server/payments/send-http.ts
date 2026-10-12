import { SandboxOnboardingError, SandboxSendError } from '@tallie/payments';
import { z } from 'zod';
import { accountRoute } from '../account-http';
import { AppError } from '../errors';
import { requireAccount } from '../identity';
import { idempotencyKey, jsonResponse, readJson } from '../http';
import { sandboxSendConnectionService, sandboxSendService } from './send-service';

const reviewBody = z.strictObject({
  recipientAccountId: z.union([z.literal('sandbox-fixture'), z.uuid()]),
  amountMinor: z.string().regex(/^[1-9]\d{0,4}$/),
  note: z.string().max(80),
});
const confirmBody = z.strictObject({ reviewId: z.uuid() });
const fundBody = z.strictObject({ amountMinor: z.string().regex(/^[1-9]\d{0,4}$/) });

function translate(error: unknown): never {
  if (error instanceof SandboxOnboardingError || error instanceof SandboxSendError)
    throw new AppError(error.code, error.message, error.status);
  throw error;
}

/** All routes are sandbox-only; the separate production application does not register them. */
export function sandboxSendRoute(action: 'state' | 'setup' | 'fund' | 'review' | 'confirm') {
  return accountRoute(async (request) => {
    const actor = await requireAccount(request);
    const service = sandboxSendService();
    try {
      // Balance reads must not move a ready connection back into setup while a
      // simultaneous funding or send command checks it.
      if (action === 'state') return jsonResponse(await service.state(actor));
      if (action === 'setup') {
        await readJson(request, z.strictObject({}));
        const connection = sandboxSendConnectionService();
        const current = await connection.state(actor);
        if (!current.connection) await connection.start(actor);
        else if (current.connection.retryAllowed) await connection.retry(actor);
        else if (current.connection.status === 'connected') await connection.refresh(actor);
        return jsonResponse(await service.state(actor));
      }
      if (action === 'fund') {
        const body = await readJson(request, fundBody);
        await service.fund(actor, body.amountMinor);
        return jsonResponse(await service.state(actor));
      }
      if (action === 'review') {
        const body = await readJson(request, reviewBody);
        const key = z.uuid().safeParse(idempotencyKey(request));
        if (!key.success)
          throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Retry this review with the same key.');
        return jsonResponse(await service.review(actor, body, key.data));
      }
      const body = await readJson(request, confirmBody);
      return jsonResponse(await service.confirm(actor, body.reviewId));
    } catch (error) {
      translate(error);
    }
  });
}
