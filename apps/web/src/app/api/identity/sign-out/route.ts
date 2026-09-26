import { z } from 'zod';
import { identityAuth } from '@tallie/identity';
import { identityRoute, readJson } from '../../../../server/identity/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  await readJson(request, z.object({}).strict());
  return identityAuth().api.signOut({ headers: request.headers, asResponse: true });
});
