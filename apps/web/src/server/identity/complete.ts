import { z } from 'zod';
import { identityAuth } from '@tallie/identity';
import { identityRoute, readJson, requireBrowser } from './http';
export function completeRoute(mode: 'signup' | 'recovery' | 'phone_demo') {
  return identityRoute(async (request) => {
    requireBrowser(request);
    const body =
      mode === 'phone_demo'
        ? await readJson(
            request,
            z
              .object({ challengeId: z.uuid(), name: z.string().trim().min(1).max(80).optional() })
              .strict(),
          )
        : mode === 'signup'
          ? await readJson(
              request,
              z.object({ challengeId: z.uuid(), name: z.string().trim().min(1).max(80) }).strict(),
            )
          : await readJson(
              request,
              z.object({ challengeId: z.uuid(), recoveryCode: z.string().min(1).max(80) }).strict(),
            );
    const url = new URL('/api/identity/auth/complete-phone', process.env.APP_ORIGIN);
    const response = await identityAuth().handler(
      new Request(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({ ...body, mode }),
      }),
    );
    if (response.ok) return response;
    // Keep the app's stable error envelope across the library boundary.
    const error = (await response.json()) as { code?: string; message?: string };
    return Response.json(
      {
        error: {
          code: error.code ?? 'IDENTITY_FAILED',
          message: error.message ?? 'Account setup could not be completed.',
        },
      },
      { status: response.status },
    );
  });
}
