import { requireAccount } from '@tallie/identity';
import { messagingConfigured } from '@tallie/messaging';
import { getMessagingService } from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse } from '@/server/http';
export const runtime = 'nodejs';
export const GET = accountRoute(async (request) => {
  const account = await requireAccount(request);
  if (!messagingConfigured())
    return jsonResponse({
      available: false,
      sendingEnabled: false,
      grant: null,
      drafts: [],
      number: null,
    });
  return jsonResponse({
    ...(await getMessagingService().state(account.userId)),
    number: process.env.SENDBLUE_FROM_NUMBER ?? null,
  });
});
