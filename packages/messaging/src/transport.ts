import { z } from 'zod';
import { DeliveryError, MessagingError, type MessagingTransport } from './contracts';
import { handleSchema, normalizeMessage } from './normalization';

const API_ORIGIN = 'https://api.sendblue.com';
const MAXIMUM_RESPONSE = 131_072;

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAXIMUM_RESPONSE) {
        await reader.cancel();
        throw new MessagingError('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class SendblueMessagingTransport implements MessagingTransport {
  constructor(
    private readonly keyId: string,
    private readonly secret: string,
    private readonly line: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'sb-api-key-id': this.keyId,
      'sb-api-secret-key': this.secret,
    };
  }

  async retrieve(handle: string) {
    handleSchema.parse(handle);
    const response = await this.fetcher(
      `${API_ORIGIN}/api/v2/messages/${encodeURIComponent(handle)}`,
      {
        headers: this.headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) throw new MessagingError('CANONICAL_MESSAGE_UNAVAILABLE', 503);
    const data = z.object({ data: z.unknown() }).parse(await responseJson(response));
    return normalizeMessage(data.data, this.line);
  }

  async send(input: Parameters<MessagingTransport['send']>[0]) {
    let response: Response;
    try {
      response = await this.fetcher(`${API_ORIGIN}/api/send-message`, {
        method: 'POST',
        headers: this.headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          from_number: input.from,
          number: input.to,
          content: input.content,
          status_callback: input.callbackUrl,
        }),
      });
    } catch {
      // Sendblue ordinary sends have no documented idempotency key. Never retry
      // a request that may already have been accepted across a lost response.
      throw new DeliveryError('unknown');
    }
    if (response.status === 429) throw new DeliveryError('rate_limited');
    if ([400, 401, 403, 404, 413, 422].includes(response.status))
      throw new DeliveryError('rejected');
    if (!response.ok) throw new DeliveryError('unknown');
    try {
      const body = z
        .object({ message_handle: handleSchema, status: z.enum(['QUEUED', 'SENT', 'DELIVERED']) })
        .parse(await responseJson(response));
      return {
        handle: body.message_handle,
        status: body.status.toLowerCase() as 'queued' | 'sent' | 'delivered',
      };
    } catch {
      throw new DeliveryError('unknown');
    }
  }
}
