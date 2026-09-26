import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { expenseInput } from '@tallie/social';
import { publishMessageDraft } from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse, readJson } from '@/server/http';
export const runtime = 'nodejs';
export const POST = accountRoute(async (request) => {
  const account = await requireAccount(request);
  const id = z.uuid().parse(new URL(request.url).pathname.split('/').at(-2));
  const input = await readJson(
    request,
    z.object({ version: z.number().int().positive(), input: expenseInput }).strict(),
  );
  return jsonResponse(await publishMessageDraft(account, id, input.version, input.input));
});
