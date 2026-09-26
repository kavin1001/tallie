import { reviewRequest } from '@/server/commands';
import { jsonResponse, principalFor, readJson, route } from '@/server/http';
import { emptySchema, parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async (req) => {
    const principal = await principalFor(req);
    await readJson(req, emptySchema);
    return jsonResponse(
      await reviewRequest(principal, parseIdentifier((await context.params).id)),
      201,
    );
  })(request);
}
