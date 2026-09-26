import { z } from 'zod';
import { requireRecentAccount, signupService } from '@tallie/identity';
import {
  identityRoute,
  jsonResponse,
  readJson,
  signupBrowser,
} from '../../../../../server/identity/http';
import { idempotencyKey } from '../../../../../server/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  await readJson(request, z.object({}).strict());
  const principal = await requireRecentAccount(request);
  const { token, headers } = signupBrowser(request);
  const result = await signupService().startChannel(principal, token, idempotencyKey(request));
  return jsonResponse(result, 200, headers);
});
