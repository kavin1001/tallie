import { z } from 'zod';
import { requireRecentAccount, signupService } from '@tallie/identity';
import { identityRoute, jsonResponse, readJson } from '../../../../server/identity/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  await readJson(request, z.object({}).strict());
  return jsonResponse({
    codes: await signupService().rotateRecoveryCodes(await requireRecentAccount(request)),
  });
});
