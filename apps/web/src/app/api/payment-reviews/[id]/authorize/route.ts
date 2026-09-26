import { authorizeReview } from '@/server/commands';
import { idempotencyKey, jsonResponse, principalFor, readJson, route } from '@/server/http';
import { authorizeSchema, parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async (req) => {
    const principal = await principalFor(req);
    const input = await readJson(req, authorizeSchema);
    return jsonResponse(
      await authorizeReview(
        principal,
        parseIdentifier((await context.params).id),
        input.reviewDigest,
        idempotencyKey(req),
      ),
      202,
    );
  })(request);
}
