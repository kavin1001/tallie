import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { normalizeReceiptImage } from '../src/media';
import { extractReceipt } from '../src/provider';

const extraction = {
  title: 'Little Lantern',
  currency: 'USD',
  items: [{ description: 'Food', quantity: '1', amountMinor: '9000' }],
  subtotalMinor: '9000',
  totalMinor: '11700',
  taxMinor: '900',
  tipMinor: '1800',
  discountMinor: '0',
  serviceChargeMinor: '0',
  confidence: 'high',
  concerns: [],
};

describe('isolated image normalization', () => {
  it('decodes the synthetic receipt, strips metadata, and only returns JPEG pixels', async () => {
    const input = await readFile(new URL('../fixtures/clean-117.png', import.meta.url));
    const withMetadata = await sharp(input).withMetadata({ orientation: 1 }).jpeg().toBuffer();
    expect((await sharp(withMetadata).metadata()).exif).toBeDefined();
    const output = await normalizeReceiptImage(withMetadata);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBeLessThanOrEqual(2400);
    expect(metadata.height).toBeLessThanOrEqual(2400);
  });
  it('rejects truncated bytes and oversized decoded dimensions before extraction', async () => {
    await expect(normalizeReceiptImage(Buffer.from([255, 216, 255, 224]))).rejects.toMatchObject({
      code: 'IMAGE_UNREADABLE',
    });
    const huge = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(normalizeReceiptImage(huge)).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
  });
  it('rejects SVG regardless of its image-like contents', async () => {
    await expect(
      normalizeReceiptImage(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
  });
});

describe('OpenAI adapter with local fixture responses', () => {
  it('sends no tools, disables response storage, and accepts only validated structured output', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(extraction) }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    const result = await extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher });
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.max_output_tokens).toBe(6000);
    expect(JSON.stringify(body.instructions)).toContain('untrusted data');
    expect(result.proposal.reconciled).toBe(true);
    expect(result.inputTokens).toBe(100);
  });
  it.each(['incomplete', 'failed'])('does not accept %s output as a receipt', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status, output: [] }));
    await expect(
      extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_INVALID', retryable: false });
  });
  it('does not expose a provider error body or leak it into an error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret provider detail', { status: 401 }));
    await expect(
      extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });
  it('only marks transient provider errors retryable', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('temporary', { status: 429 }));
    await expect(
      extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher }),
    ).rejects.toMatchObject({ retryable: true });
  });
  it('rejects oversized output and refusals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(262145)));
    await expect(
      extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_INVALID' });
    fetcher.mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }],
      }),
    );
    await expect(
      extractReceipt(Buffer.from('synthetic'), { apiKey: 'test-only', fetcher }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_INVALID' });
  });
});
