import { requireAccount } from '@/server/identity';
import { jsonResponse } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export const GET = socialRoute(async (request) =>
  jsonResponse(await socialService().dashboard(await requireAccount(request))),
);
