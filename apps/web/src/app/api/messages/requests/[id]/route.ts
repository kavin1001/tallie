import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { resolveMessageRequest } from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse } from '@/server/http';
export const runtime = 'nodejs';
export const GET = accountRoute(async (request) => {
  const account = await requireAccount(request);
  const id = z.uuid().parse(new URL(request.url).pathname.split('/').at(-1));
  return jsonResponse(await resolveMessageRequest(account, id));
});
