import {
  identityAvailable,
  identityAuth,
  identityDatabase,
  accountForSession,
  signupService,
} from '@tallie/identity';
import { identityRoute, jsonResponse, signupBrowser } from '../../../../server/identity/http';
export const runtime = 'nodejs';
export const GET = identityRoute(async (request) => {
  if (!identityAvailable())
    return jsonResponse({ available: false, account: null, challenge: null });
  const { token, headers } = signupBrowser(request);
  const session = await identityAuth().api.getSession({ headers: request.headers });
  return jsonResponse(
    {
      available: true,
      account: session ? await accountForSession(identityDatabase(), session.session.id) : null,
      challenge: await signupService().current(token),
    },
    200,
    headers,
  );
});
