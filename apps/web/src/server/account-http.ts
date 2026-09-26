import { randomUUID } from 'node:crypto';
import { DomainError } from '@tallie/domain';
import { IdentityError } from '@tallie/identity';
import { ReceiptError } from '@tallie/receipts';
import { MessagingError } from '@tallie/messaging';
import { SocialError } from '@tallie/social';
import { z } from 'zod';
import { AppError } from './errors';
import { assertMutationOrigin } from './http';

const messageErrors: Record<string, string> = {
  MESSAGE_DRAFT_NOT_FOUND: 'This conversation draft has expired or is unavailable.',
  MESSAGE_DRAFT_CHANGED:
    'Your conversation has changed. Reopen the draft to review its latest details.',
  MESSAGE_DRAFT_CLOSED:
    'This draft has already been completed. Reopen Messages to see the saved split.',
  MESSAGE_PUBLICATION_IN_PROGRESS: 'This split is being saved. Wait a moment, then reopen it.',
  PUBLICATION_RETRY_CONFLICT:
    'This retry has different details. Reopen the draft to check its saved version.',
  MESSAGE_REQUEST_NOT_FOUND: 'This request is unavailable for your account.',
  CHANNEL_RECONNECT_REQUIRED: 'Reconnect Messages from your account to continue.',
  MESSAGING_NOT_CONFIGURED: 'Messages has not been connected in this environment yet.',
};

/** Real-account endpoints do not inherit the demo's identity or financial permissions. */
export function accountRoute(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      if (!['demo', 'beta'].includes(process.env.APP_MODE ?? ''))
        throw new AppError('UNAVAILABLE', 'Tallie is not configured for this environment.', 503);
      if (request.method !== 'GET' && request.method !== 'HEAD') assertMutationOrigin(request);
      const response = await handler(request);
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch (error) {
      if (error instanceof z.ZodError)
        return Response.json(
          {
            error: {
              code: 'INVALID_INPUT',
              message: 'Check the details and try again.',
              requestId,
            },
          },
          {
            status: 400,
            headers: { 'Cache-Control': 'private, no-store', 'X-Request-ID': requestId },
          },
        );
      if (error instanceof MessagingError)
        return Response.json(
          {
            error: {
              code: error.code,
              message:
                messageErrors[error.code] ??
                'This Messages action is unavailable. Refresh and try again.',
              requestId,
            },
          },
          {
            status: error.status,
            headers: { 'Cache-Control': 'private, no-store', 'X-Request-ID': requestId },
          },
        );
      const known =
        error instanceof AppError ||
        error instanceof DomainError ||
        error instanceof IdentityError ||
        error instanceof ReceiptError ||
        error instanceof SocialError;
      const status =
        error instanceof AppError ||
        error instanceof IdentityError ||
        error instanceof ReceiptError ||
        error instanceof SocialError
          ? error.status
          : known
            ? 400
            : 500;
      if (!known)
        console.error(
          JSON.stringify({
            event: 'account_request_failed',
            requestId,
            errorType: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      return Response.json(
        {
          error: {
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known ? error.message : 'This action was interrupted. Please try again.',
            requestId,
          },
        },
        { status, headers: { 'Cache-Control': 'private, no-store', 'X-Request-ID': requestId } },
      );
    }
  };
}
