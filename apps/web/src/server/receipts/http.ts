import { z } from 'zod';
import { RECEIPT_MAX_BYTES, ReceiptError, type ReceiptUpload } from '@tallie/receipts';
import { AppError } from '../errors';
import { route } from '../http';

const uploadSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil(RECEIPT_MAX_BYTES / 3) * 4),
  })
  .strict();

/** Local upload limit only; the application's ordinary JSON limit stays 64 KiB. */
export async function readReceiptUpload(request: Request): Promise<ReceiptUpload> {
  const maximum = Math.ceil(RECEIPT_MAX_BYTES / 3) * 4 + 512;
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new AppError('PAYLOAD_TOO_LARGE', 'Choose a receipt photo up to 8 MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_IMAGE', 'Choose a receipt photo.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new AppError('PAYLOAD_TOO_LARGE', 'Choose a receipt photo up to 8 MB.', 413);
    }
    chunks.push(value);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'This photo upload could not be read. Please try again.');
  }
  const result = uploadSchema.safeParse(json);
  if (!result.success)
    throw new AppError('INVALID_IMAGE', 'Choose a JPEG, PNG, or WebP receipt photo up to 8 MB.');
  return result.data;
}

export function receiptRoute(handler: (request: Request) => Promise<Response>) {
  return route(async (request) => {
    if (process.env.RECEIPTS_ENABLED !== 'true')
      throw new AppError('RECEIPTS_UNAVAILABLE', 'Receipt reading is not connected yet.', 503);
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof ReceiptError)
        throw new AppError(
          error.code,
          error.message,
          error.code === 'CONFIGURATION_REQUIRED' ? 503 : 400,
        );
      throw error;
    }
  });
}
