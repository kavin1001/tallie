import { tokenInput } from '@tallie/social';
import { jsonResponse, readJson } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export const POST = socialRoute(async (request) =>
  jsonResponse(
    await socialService().inspectInvitation((await readJson(request, tokenInput)).token),
  ),
);
