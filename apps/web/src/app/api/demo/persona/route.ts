import { jsonResponse, principalFor, readJson, route } from '@/server/http';
import { getDashboard } from '@/server/queries';
import { resolveSession, sessionCookie, switchDemoPersona } from '@/server/session';
import { personaSchema } from '@/server/validation';

export const runtime = 'nodejs';
export const POST = route(async (request) => {
  const principal = await principalFor(request);
  const input = await readJson(request, personaSchema);
  const token = await switchDemoPersona(principal, input.personId);
  return jsonResponse(await getDashboard(await resolveSession(token)), 200, {
    'Set-Cookie': sessionCookie(token),
  });
});
