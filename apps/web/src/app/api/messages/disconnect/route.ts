import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { getMessagingService } from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse, readJson } from '@/server/http';
export const runtime = 'nodejs';
export const POST = accountRoute(async (request) => {
  await readJson(request, z.object({}).strict());
  await getMessagingService().revokeGrant((await requireAccount(request)).userId);
  return jsonResponse({ disconnected: true });
});
