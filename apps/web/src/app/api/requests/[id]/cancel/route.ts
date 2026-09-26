import { changeRequest } from '@/server/commands';
import { jsonResponse, principalFor, readJson, route } from '@/server/http';
import { parseIdentifier, versionSchema } from '@/server/validation';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async (req) => {
    const principal = await principalFor(req);
    const input = await readJson(req, versionSchema);
    return jsonResponse(
      await changeRequest(principal, parseIdentifier((await context.params).id), {
        ...input,
        action: 'cancel',
      }),
    );
  })(request);
}
