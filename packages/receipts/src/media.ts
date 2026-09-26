import sharp from 'sharp';
import { RECEIPT_MAX_BYTES, RECEIPT_MAX_PIXELS } from './contracts';
import { ReceiptError } from './errors';
import { sniffReceiptType } from './upload';

/** Import this decoder only in the dedicated receipt worker. EXIF is never retained. */
export async function normalizeReceiptImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > RECEIPT_MAX_BYTES || !sniffReceiptType(bytes))
    throw new ReceiptError(
      'UNSUPPORTED_IMAGE',
      'Choose a JPEG, PNG, or WebP receipt photo up to 8 MB.',
    );
  sharp.cache(false);
  sharp.concurrency(1);
  try {
    const pipeline = sharp(bytes, {
      limitInputPixels: RECEIPT_MAX_PIXELS,
      failOn: 'warning',
      sequentialRead: true,
    }).timeout({ seconds: 10 });
    const metadata = await pipeline.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1 ||
      !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')
    )
      throw new Error('Unsupported image');
    const output = await pipeline
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .timeout({ seconds: 10 })
      .toBuffer();
    if (output.length > RECEIPT_MAX_BYTES) throw new Error('Output too large');
    return output;
  } catch {
    throw new ReceiptError(
      'IMAGE_UNREADABLE',
      'This photo could not be opened safely. Try a smaller JPEG, PNG, or WebP image.',
    );
  }
}
