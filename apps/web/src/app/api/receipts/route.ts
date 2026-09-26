import { idempotencyKey, jsonResponse, principalFor } from '@/server/http';
import { readReceiptUpload, receiptRoute } from '@/server/receipts/http';
import { createReceiptDraft } from '@/server/receipts/service';

export const runtime = 'nodejs';
export const POST = receiptRoute(async (request) => {
  const principal = await principalFor(request);
  const retryKey = idempotencyKey(request);
  const input = await readReceiptUpload(request);
  return jsonResponse(await createReceiptDraft(principal, input, retryKey), 202);
});
