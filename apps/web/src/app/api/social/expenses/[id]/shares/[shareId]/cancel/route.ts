import { z } from 'zod';
import { emptyInput } from '@tallie/social';
import { requireAccount } from '@/server/identity';
import { jsonResponse, readJson } from '@/server/http';
import { socialRoute } from '@/server/social/http';
import { socialService } from '@/server/social/service';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; shareId: string }> },
): Promise<Response> {
  return socialRoute(async (req) => {
    const actor = await requireAccount(req);
    await readJson(req, emptyInput);
    const params = await context.params;
    return jsonResponse(
      await socialService().cancelShare(
        actor,
        z.uuid().parse(params.id),
        z.uuid().parse(params.shareId),
      ),
    );
  })(request);
}
