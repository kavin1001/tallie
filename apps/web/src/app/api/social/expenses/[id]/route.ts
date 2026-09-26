import { z } from 'zod';
import { requireAccount } from '@/server/identity';
import { jsonResponse } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return socialRoute(async (req) =>
    jsonResponse(
      await socialService().expense(
        (await requireAccount(req)).userId,
        z.uuid().parse((await context.params).id),
      ),
    ),
  )(request);
}
