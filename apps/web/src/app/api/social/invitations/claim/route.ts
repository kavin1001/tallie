import { tokenInput } from '@tallie/social';
import { requireAccount } from '@/server/identity';
import { jsonResponse, readJson } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export const POST = socialRoute(async (request) =>
  jsonResponse(
    await socialService().claimInvitation(
      await requireAccount(request),
      (await readJson(request, tokenInput)).token,
    ),
  ),
);
