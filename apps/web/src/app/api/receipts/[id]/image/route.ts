import { principalFor } from '@/server/http';
import { receiptRoute } from '@/server/receipts/http';
import { getReceiptImage } from '@/server/receipts/service';
import { parseIdentifier } from '@/server/validation';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return receiptRoute(async (req) => {
    const bytes = await getReceiptImage(
      await principalFor(req),
      parseIdentifier((await context.params).id),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': 'inline; filename="receipt.jpg"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
      },
    });
  })(request);
}
