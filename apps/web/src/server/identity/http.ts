import { randomUUID } from 'node:crypto';
import {
  IdentityError,
  browserTokenFromHeaders,
  SIGNUP_COOKIE,
  opaqueToken,
} from '@tallie/identity';
import { assertMutationOrigin, jsonResponse, readJson } from '../http';
import { AppError } from '../errors';
export { jsonResponse, readJson };
export function identityRoute(handler: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      if (!['GET', 'HEAD'].includes(request.method)) assertMutationOrigin(request);
      const response = await handler(request);
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch (error) {
      const known = error instanceof IdentityError || error instanceof AppError;
      if (!known)
        console.error(
          JSON.stringify({
            event: 'identity_request_failed',
            requestId,
            errorType: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      return Response.json(
        {
          error: {
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known
              ? error.message
              : 'We could not complete that account action. Try again.',
            requestId,
          },
        },
        {
          status: known ? error.status : 500,
          headers: { 'Cache-Control': 'private, no-store', 'X-Request-ID': requestId },
        },
      );
    }
  };
}
export function requireBrowser(request: Request): string {
  const token = browserTokenFromHeaders(request.headers);
  if (!token)
    throw new IdentityError(
      'SIGNUP_SESSION_REQUIRED',
      'Start verification from this browser.',
      401,
    );
  return token;
}
export function signupBrowser(request: Request): { token: string; headers: Headers } {
  const previous = browserTokenFromHeaders(request.headers),
    token = previous ?? opaqueToken();
  const headers = new Headers();
  if (!previous)
    headers.set(
      'Set-Cookie',
      `${SIGNUP_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${process.env.APP_ORIGIN?.startsWith('https:') ? '; Secure' : ''}`,
    );
  return { token, headers };
}
