import { z } from 'zod';
import { requireAccount } from '@tallie/identity';
import { readOwnedReceipt } from '@tallie/receipts/owned';
import { accountRoute } from '@/server/account-http';
import { jsonResponse } from '@/server/http';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return accountRoute(async () => {
    const actor = await requireAccount(request);
    const id = z.uuid().parse((await context.params).id);
    return jsonResponse(await readOwnedReceipt(actor.userId, id));
  })(request);
}
