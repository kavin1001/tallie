import { z } from 'zod';
import { removeAccountPasskey, requireRecentAccount, IdentityError } from '@tallie/identity';
import { identityRoute, jsonResponse, readJson } from '../../../../../../server/identity/http';
export const runtime = 'nodejs';
export const POST = identityRoute(async (request) => {
  await readJson(request, z.object({}).strict());
  const id = new URL(request.url).pathname.split('/').at(-2);
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success)
    throw new IdentityError('INVALID_PASSKEY', 'This passkey could not be found.');
  return jsonResponse(await removeAccountPasskey(await requireRecentAccount(request), parsed.data));
});
