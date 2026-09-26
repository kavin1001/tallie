import { invitationInput } from '@tallie/social';
import { requireAccount } from '@/server/identity';
import { idempotencyKey, jsonResponse, readJson } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export const POST = socialRoute(async (request) =>
  jsonResponse(
    await socialService().createInvitation(
      await requireAccount(request),
      await readJson(request, invitationInput),
      idempotencyKey(request),
    ),
    201,
  ),
);
