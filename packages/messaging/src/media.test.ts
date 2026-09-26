import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadReceiptMedia } from './media';

const network = vi.hoisted(() => ({
  addresses: ['1.1.1.1'],
  responses: [] as { status: number; headers: Record<string, string>; bytes: Buffer }[],
  pinned: [] as string[],
  requests: 0,
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => network.addresses.map((address) => ({ address, family: 4 }))),
}));

vi.mock('node:https', () => ({
  request: (
    _url: URL,
    options: {
      lookup: (
        hostname: string,
        options: { all: boolean },
        callback: (error: unknown, address: string) => void,
      ) => void;
    },
    callback: (
      response: EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: (error?: Error) => void;
      },
    ) => void,
  ) => {
    network.requests++;
    const next = network.responses.shift()!;
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => typeof request;
    };
    request.destroy = (error) => {
      if (error) request.emit('error', error);
      request.emit('close');
      return request;
    };
    request.end = () => {
      queueMicrotask(() => {
        options.lookup('cdn.sendblue.co', { all: false }, (_error, address) =>
          network.pinned.push(address),
        );
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: (error?: Error) => void;
        };
        let destroyed = false;
        response.statusCode = next.status;
        response.headers = next.headers;
        response.destroy = (error) => {
          destroyed = true;
          if (error) response.emit('error', error);
        };
        callback(response);
        queueMicrotask(() => {
          if (!destroyed) {
            response.emit('data', next.bytes);
            if (!destroyed) response.emit('end');
          }
          request.emit('close');
        });
      });
    };
    return request;
  },
}));

beforeEach(() => {
  network.addresses = ['1.1.1.1'];
  network.responses = [];
  network.pinned = [];
  network.requests = 0;
});

describe('media downloader at the socket boundary', () => {
  it('pins the validated public IP to the HTTPS connection', async () => {
    network.responses.push({
      status: 200,
      headers: { 'content-type': 'image/png' },
      bytes: Buffer.from('synthetic'),
    });
    const result = await downloadReceiptMedia('https://cdn.sendblue.co/media/receipt.png');
    expect(result.bytes.toString()).toBe('synthetic');
    expect(result.contentType).toBe('image/png');
    expect(network.pinned).toEqual(['1.1.1.1']);
  });
  it('refuses mixed public/private DNS answers before making any connection', async () => {
    network.addresses = ['1.1.1.1', '169.254.169.254'];
    await expect(downloadReceiptMedia('https://cdn.sendblue.co/media/x')).rejects.toThrow(
      'MEDIA_ADDRESS_REJECTED',
    );
    expect(network.requests).toBe(0);
  });
  it('revalidates a redirect target and refuses a move to internal or untrusted origins', async () => {
    network.responses.push({
      status: 302,
      headers: { location: 'https://127.0.0.1/private' },
      bytes: Buffer.alloc(0),
    });
    await expect(downloadReceiptMedia('https://cdn.sendblue.co/media/x')).rejects.toThrow(
      'MEDIA_URL_REJECTED',
    );
    expect(network.requests).toBe(1);
  });
  it('caps streamed bytes even if content-length is missing', async () => {
    network.responses.push({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      bytes: Buffer.alloc(8 * 1024 * 1024 + 1),
    });
    await expect(downloadReceiptMedia('https://cdn.sendblue.co/media/x')).rejects.toThrow(
      'MEDIA_INTERRUPTED',
    );
  });
  it('does not accept HTML or currently unsupported HEIC', async () => {
    network.responses.push({
      status: 200,
      headers: { 'content-type': 'image/heic' },
      bytes: Buffer.from('synthetic'),
    });
    await expect(downloadReceiptMedia('https://cdn.sendblue.co/media/x')).rejects.toThrow(
      'MEDIA_UNSUPPORTED',
    );
  });
});
