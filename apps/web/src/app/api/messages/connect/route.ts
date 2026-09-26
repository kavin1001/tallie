import { z } from 'zod';
import { requireRecentAccount } from '@tallie/identity';
import {
  currentMessageIdentity,
  getMessagingService,
  requireFreshMessageEnrollment,
} from '@tallie/app-services';
import { accountRoute } from '@/server/account-http';
import { jsonResponse, readJson } from '@/server/http';
export const runtime = 'nodejs';
export const POST = accountRoute(async (request) => {
  const { notifications } = await readJson(
    request,
    z.object({ consent: z.literal(true), notifications: z.boolean() }).strict(),
  );
  const account = await requireRecentAccount(request);
  await requireFreshMessageEnrollment(account);
  const state = await getMessagingService().createGrant(
    await currentMessageIdentity(account),
    notifications,
  );
  return jsonResponse({ ...state, number: process.env.SENDBLUE_FROM_NUMBER ?? null });
});
