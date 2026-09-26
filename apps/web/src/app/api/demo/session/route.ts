import { createDemoWorkspace, database } from '@tallie/db';
import { AppError } from '@/server/errors';
import { jsonResponse, readJson, route } from '@/server/http';
import { getDashboard } from '@/server/queries';
import { resolveSession, sessionCookie, tokenFromRequest } from '@/server/session';
import { emptySchema } from '@/server/validation';

export const runtime = 'nodejs';
export const POST = route(async (request) => {
  await readJson(request, emptySchema);
  const existing = tokenFromRequest(request);
  if (existing) {
    try {
      return jsonResponse(await getDashboard(await resolveSession(existing)));
    } catch (error) {
      if (!(error instanceof AppError && error.status === 401)) throw error;
    }
  }
  const session = await createDemoWorkspace(database());
  const principal = await resolveSession(session.token);
  return jsonResponse(await getDashboard(principal), 201, {
    'Set-Cookie': sessionCookie(session.token),
  });
});
