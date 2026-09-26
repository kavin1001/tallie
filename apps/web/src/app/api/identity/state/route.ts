import {
  identityAvailable,
  identityAuth,
  identityDatabase,
  accountForSession,
  signupService,
  phoneDemoEnabled,
} from '@tallie/identity';
import { identityRoute, jsonResponse, signupBrowser } from '../../../../server/identity/http';
export const runtime = 'nodejs';
export const GET = identityRoute(async (request) => {
  if (!identityAvailable())
    return jsonResponse({
      available: false,
      authenticationMode: 'passkey',
      account: null,
      challenge: null,
    });
  const { token, headers } = signupBrowser(request);
  const session = await identityAuth().api.getSession({ headers: request.headers });
  return jsonResponse(
    {
      available: true,
      authenticationMode: phoneDemoEnabled() ? 'phone_demo' : 'passkey',
      account: session ? await accountForSession(identityDatabase(), session.session.id) : null,
      challenge: await signupService().current(token),
    },
    200,
    headers,
  );
});
