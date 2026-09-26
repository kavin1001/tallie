import { z } from 'zod';
import { signupService } from '@tallie/identity';
import {
  identityRoute,
  jsonResponse,
  readJson,
  requireBrowser,
} from '../../../../../server/identity/http';
import { idempotencyKey } from '../../../../../server/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  const body = await readJson(request, z.object({ phone: z.string().max(30) }).strict());
  return jsonResponse(
    await signupService().start(requireBrowser(request), body.phone, idempotencyKey(request)),
  );
});
