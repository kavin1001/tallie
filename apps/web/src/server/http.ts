import { randomUUID } from 'node:crypto';
import { DomainError } from '@tallie/domain';
import { z } from 'zod';
import { AppError } from './errors';
import { resolveSession, tokenFromRequest, type Principal } from './session';

export function assertDemoMode(): void {
  if (process.env.APP_MODE !== 'demo')
    throw new AppError(
      'LIVE_INTEGRATIONS_UNAVAILABLE',
      'Live payments are not connected. This build is a private demo.',
      503,
    );
}

export function assertMutationOrigin(request: Request): void {
  const expected = process.env.APP_ORIGIN;
  if (!expected)
    throw new AppError('CONFIGURATION_REQUIRED', 'The app origin has not been configured.', 503);
  if (
    request.headers.get('origin') !== new URL(expected).origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new AppError('ORIGIN_REJECTED', 'Open this action from the Tallie app.', 403);
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new AppError('INVALID_CONTENT_TYPE', 'This action needs a JSON request.', 415);
  }
}

export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  const maximum = 65_536;
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new AppError('PAYLOAD_TOO_LARGE', 'This request is too large.', 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new AppError('PAYLOAD_TOO_LARGE', 'This request is too large.', 413);
      }
      chunks.push(value);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new AppError('INVALID_JSON', 'This request could not be read. Please try again.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new AppError(
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Check the information and try again.',
    );
  return parsed.data;
}

export function idempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This action needs a unique retry key.');
  return key;
}

export function jsonResponse<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return Response.json(
    { data },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        ...Object.fromEntries(new Headers(headers)),
      },
    },
  );
}

type Handler = (request: Request, requestId: string) => Promise<Response>;

export function route(handler: Handler): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestId = randomUUID();
    try {
      assertDemoMode();
      if (request.method !== 'GET' && request.method !== 'HEAD') assertMutationOrigin(request);
      const response = await handler(request, requestId);
      response.headers.set('X-Request-ID', requestId);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    } catch (error) {
      const known = error instanceof AppError || error instanceof DomainError;
      const status =
        error instanceof AppError ? error.status : error instanceof DomainError ? 400 : 500;
      if (!known)
        console.error(
          JSON.stringify({
            event: 'request_failed',
            requestId,
            errorType: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      return Response.json(
        {
          error: {
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known ? error.message : 'Something interrupted this action. Please try again.',
            requestId,
          },
        },
        { status, headers: { 'Cache-Control': 'private, no-store', 'X-Request-ID': requestId } },
      );
    }
  };
}

export async function principalFor(request: Request): Promise<Principal> {
  return resolveSession(tokenFromRequest(request));
}
