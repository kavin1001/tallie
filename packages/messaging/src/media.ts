import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { MessagingError } from './contracts';

// The provider reference documents this CDN. Add hosts only after verifying an
// actual provider fixture; do not turn this into a user-configurable URL proxy.
const MEDIA_HOSTS = new Set(['cdn.sendblue.co']);
const MAXIMUM_BYTES = 8 * 1024 * 1024;

export function mediaUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MessagingError('MEDIA_URL_REJECTED');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !MEDIA_HOSTS.has(url.hostname)
  )
    throw new MessagingError('MEDIA_URL_REJECTED');
  return url;
}

export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export interface ReceiptMedia {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export async function downloadReceiptMedia(input: string): Promise<ReceiptMedia> {
  const deadline = Date.now() + 15_000;
  let current = mediaUrl(input);
  for (let hop = 0; hop <= 2; hop++) {
    const addresses = await Promise.race([
      lookup(current.hostname, { family: 4, all: true }),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new MessagingError('MEDIA_TIMEOUT')),
          Math.max(1, deadline - Date.now()),
        );
        timeout.unref();
      }),
    ]);
    if (!addresses.length || addresses.some((item) => !publicIpv4(item.address)))
      throw new MessagingError('MEDIA_ADDRESS_REJECTED');
    const address = addresses[0]!.address;
    const result = await new Promise<ReceiptMedia | { redirect: string }>((resolve, reject) => {
      const req = request(
        current,
        {
          method: 'GET',
          agent: false,
          servername: current.hostname,
          // Pin the validated DNS result to this connection. The default resolver
          // must not run again after validation (DNS rebinding / TOCTOU).
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
          headers: { Accept: 'image/jpeg, image/png, image/webp' },
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            response.destroy();
            if (!response.headers.location) reject(new MessagingError('MEDIA_REDIRECT_REJECTED'));
            else resolve({ redirect: response.headers.location });
            return;
          }
          const type = response.headers['content-type']?.split(';')[0]?.trim();
          if (
            response.statusCode !== 200 ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(type ?? '') ||
            Number(response.headers['content-length'] ?? 0) > MAXIMUM_BYTES
          ) {
            response.destroy();
            reject(new MessagingError('MEDIA_UNSUPPORTED'));
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAXIMUM_BYTES) {
              response.destroy(new MessagingError('MEDIA_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => reject(new MessagingError('MEDIA_INTERRUPTED')));
          response.on('end', () => {
            if (!length) reject(new MessagingError('MEDIA_EMPTY'));
            else
              resolve({
                bytes: Buffer.concat(chunks),
                contentType: type as ReceiptMedia['contentType'],
              });
          });
        },
      );
      const timeout = setTimeout(
        () => req.destroy(new MessagingError('MEDIA_TIMEOUT')),
        Math.max(1, deadline - Date.now()),
      );
      req.on('close', () => clearTimeout(timeout));
      req.on('error', () => reject(new MessagingError('MEDIA_UNAVAILABLE')));
      req.end();
    });
    if ('bytes' in result) return result;
    current = mediaUrl(new URL(result.redirect, current).toString());
  }
  throw new MessagingError('MEDIA_REDIRECT_REJECTED');
}
