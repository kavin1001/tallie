import { requireAccount, lockAccount } from '@tallie/identity';
import { createOwnedReceipt } from '@tallie/receipts/owned';
import { accountRoute } from '@/server/account-http';
import { jsonResponse, idempotencyKey } from '@/server/http';
import { readReceiptUpload } from '@/server/receipts/http';
import { AppError } from '@/server/errors';
export const POST = accountRoute(async (request) => {
  const account = await requireAccount(request);
  if (process.env.RECEIPTS_ENABLED !== 'true')
    throw new AppError('RECEIPTS_UNAVAILABLE', 'Receipt reading is not connected yet.', 503);
  const input = await readReceiptUpload(request);
  return jsonResponse(
    await createOwnedReceipt(account.userId, input, idempotencyKey(request), (tx) =>
      lockAccount(tx, account),
    ),
    202,
  );
});
