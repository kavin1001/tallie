import { changeRequest } from '@/server/commands';
import { jsonResponse, principalFor, readJson, route } from '@/server/http';
import { issueSchema, parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async (req) => {
    const principal = await principalFor(req);
    const input = await readJson(req, issueSchema);
    return jsonResponse(
      await changeRequest(principal, parseIdentifier((await context.params).id), {
        ...input,
        action: 'issue',
      }),
    );
  })(request);
}
