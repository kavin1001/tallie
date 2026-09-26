import { z } from 'zod';
import { requireRecentAccount, signupService } from '@tallie/identity';
import {
  identityRoute,
  jsonResponse,
  readJson,
  requireBrowser,
} from '../../../../../server/identity/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  const body = await readJson(request, z.object({ challengeId: z.uuid() }).strict());
  return jsonResponse(
    await signupService().completeChannel(
      await requireRecentAccount(request),
      requireBrowser(request),
      body.challengeId,
    ),
  );
});
