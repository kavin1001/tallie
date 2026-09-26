import { jsonResponse, principalFor } from '@/server/http';
import { receiptRoute } from '@/server/receipts/http';
import { getReceiptDraft } from '@/server/receipts/service';
import { parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return receiptRoute(async (req) =>
    jsonResponse(
      await getReceiptDraft(await principalFor(req), parseIdentifier((await context.params).id)),
    ),
  )(request);
}
