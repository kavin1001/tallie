import { describe, expect, it } from 'vitest';
import { readReceiptUpload, receiptRoute } from './http';

describe('receipt HTTP boundary', () => {
  it('rejects unsupported shape and malformed JSON', async () => {
    await expect(
      readReceiptUpload(
        new Request('http://localhost/api/receipts', { method: 'POST', body: '{' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_JSON' });
    await expect(
      readReceiptUpload(
        new Request('http://localhost/api/receipts', {
          method: 'POST',
          body: JSON.stringify({ contentType: 'image/svg+xml', contentBase64: 'eA==' }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(
      readReceiptUpload(
        new Request('http://localhost/api/receipts', {
          method: 'POST',
          body: JSON.stringify({
            contentType: 'image/png',
            contentBase64: 'eA==',
            publicUrl: 'https://elsewhere.test/file',
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });
  it('checks the declared size before reading the body', async () => {
    await expect(
      readReceiptUpload(
        new Request('http://localhost/api/receipts', {
          method: 'POST',
          headers: { 'Content-Length': '12000000' },
          body: '{}',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
  it('bounds streamed bytes when Content-Length is missing', async () => {
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 12) controller.enqueue(new Uint8Array(1_048_576));
        else controller.close();
      },
    });
    const request = new Request('http://localhost/api/receipts', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expect(readReceiptUpload(request)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
  it('retains Origin enforcement and fails closed when capture is disabled', async () => {
    const previous = {
      mode: process.env.APP_MODE,
      origin: process.env.APP_ORIGIN,
      receipts: process.env.RECEIPTS_ENABLED,
    };
    process.env.APP_MODE = 'demo';
    process.env.APP_ORIGIN = 'http://localhost:3000';
    process.env.RECEIPTS_ENABLED = 'false';
    try {
      const handler = receiptRoute(async () => Response.json({ unreachable: true }));
      const rejected = await handler(
        new Request('http://localhost:3000/api/receipts', {
          method: 'POST',
          headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
      expect(rejected.status).toBe(403);
      const disabled = await handler(new Request('http://localhost:3000/api/receipts'));
      expect(disabled.status).toBe(503);
      expect(disabled.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      for (const [key, value] of [
        ['APP_MODE', previous.mode],
        ['APP_ORIGIN', previous.origin],
        ['RECEIPTS_ENABLED', previous.receipts],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
