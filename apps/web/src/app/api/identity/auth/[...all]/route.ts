import { identityAuth } from '@tallie/identity';
import { identityRoute } from '../../../../../server/identity/http';
export const runtime = 'nodejs';
// Keep the auth surface small. Phone completion is exposed only by the app's bounded JSON wrapper.
const allowed = new Set([
  '/get-session',
  '/sign-out',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);
const handler = identityRoute(async (request) => {
  const path = new URL(request.url).pathname.slice('/api/identity/auth'.length);
  if (!allowed.has(path))
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'This account action is not available.' } },
      { status: 404 },
    );
  if (request.method === 'POST') {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(next.value);
      }
    return identityAuth().handler(
      new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: Buffer.concat(chunks),
      }),
    );
  }
  return identityAuth().handler(request);
});
export const GET = handler;
export const POST = handler;
