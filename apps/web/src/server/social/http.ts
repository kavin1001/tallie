import { randomUUID } from 'node:crypto';
import { DomainError } from '@tallie/domain';
import { IdentityError } from '@tallie/identity';
import { SocialError } from '@tallie/social';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { assertMutationOrigin } from '../http';

/** Real social routes share origin/JSON bounds but never inherit demo identity. */
export function socialRoute(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestId = randomUUID();
    try {
      if (!['GET', 'HEAD'].includes(request.method)) assertMutationOrigin(request);
      const response = await handler(request);
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch (error) {
      const known =
        error instanceof AppError ||
        error instanceof SocialError ||
        error instanceof IdentityError ||
        error instanceof DomainError;
      const invalid = error instanceof ZodError;
      if (!known && !invalid)
        console.error(
          JSON.stringify({
            event: 'social_request_failed',
            requestId,
            errorType: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      return Response.json(
        {
          error: {
            code: known ? error.code : invalid ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
            message: known
              ? error.message
              : invalid
                ? 'Check the information and try again.'
                : 'Something interrupted this action. Please try again.',
            requestId,
          },
        },
        {
          status: known && 'status' in error ? error.status : known || invalid ? 400 : 500,
          headers: {
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Request-ID': requestId,
          },
        },
      );
    }
  };
}
