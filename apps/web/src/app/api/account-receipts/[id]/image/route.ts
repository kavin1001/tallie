import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { readOwnedImage } from '@tallie/receipts/owned';
import { accountRoute } from '@/server/account-http';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return accountRoute(async () => {
    const actor = await requireAccount(request);
    const id = z.uuid().parse((await context.params).id);
    return new Response(new Uint8Array(await readOwnedImage(actor.userId, id)), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': 'inline; filename="receipt.jpg"',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  })(request);
}
