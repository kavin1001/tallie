import { RECEIPT_MAX_BYTES, type ReceiptContentType } from './contracts';
import { ReceiptError } from './errors';

/** Header checks do not decode untrusted bytes in the web process. */
export function sniffReceiptType(bytes: Uint8Array): ReceiptContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export function decodeReceiptUpload(
  contentBase64: string,
  declaredType: ReceiptContentType,
): Buffer {
  if (
    contentBase64.length > Math.ceil(RECEIPT_MAX_BYTES / 3) * 4 ||
    contentBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
  )
    throw new ReceiptError('INVALID_IMAGE', 'Choose a valid receipt photo up to 8 MB.');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (
    !bytes.length ||
    bytes.length > RECEIPT_MAX_BYTES ||
    bytes.toString('base64') !== contentBase64
  )
    throw new ReceiptError('INVALID_IMAGE', 'Choose a valid receipt photo up to 8 MB.');
  if (sniffReceiptType(bytes) !== declaredType)
    throw new ReceiptError('UNSUPPORTED_IMAGE', 'Choose a JPEG, PNG, or WebP receipt photo.');
  return bytes;
}
