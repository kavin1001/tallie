import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { resumeMessageDraft } from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse, readJson } from '@/server/http';
export const runtime = 'nodejs';
export const POST = accountRoute(async (request) => {
  const account = await requireAccount(request);
  await readJson(request, z.object({}).strict());
  const id = z.uuid().parse(new URL(request.url).pathname.split('/').at(-3));
  return jsonResponse(await resumeMessageDraft(account, id));
});
