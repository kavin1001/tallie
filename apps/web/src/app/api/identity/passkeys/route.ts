import { listAccountPasskeys, requireAccount } from '@tallie/identity';
import { identityRoute, jsonResponse } from '../../../../server/identity/http';
export const runtime = 'nodejs';
export const GET = identityRoute(async (request) =>
  jsonResponse({ passkeys: await listAccountPasskeys(await requireAccount(request)) }),
);
