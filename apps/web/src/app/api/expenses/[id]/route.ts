import { jsonResponse, principalFor, route } from '@/server/http';
import { getExpenseDetail } from '@/server/queries';
import { parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async (req) =>
    jsonResponse(
      await getExpenseDetail(await principalFor(req), parseIdentifier((await context.params).id)),
    ),
  )(request);
}
