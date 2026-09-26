import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECEIPT_MAX_BYTES } from '../src/contracts';
import { ReceiptError } from '../src/errors';
import {
  receiptObjectKey,
  receiptS3ClientConfig,
  receiptS3Settings,
  S3ReceiptStorage,
  type ReceiptS3Port,
} from '../src/storage-s3';
import {
  deleteReceiptFiles,
  readReceiptImage,
  receiptPath,
  staleReceiptFiles,
  storageDirectory,
  storeNormalized,
  storeOriginal,
} from '../src/storage';
const settings = {
  bucket: 'tallie-private-test-fixture',
  region: 'us-east-1',
  expectedOwner: '123456789012',
};
function output(body: Readable, length?: number): GetObjectCommandOutput {
  return {
    Body: body as NonNullable<GetObjectCommandOutput['Body']>,
    $metadata: {},
    ...(length === undefined ? {} : { ContentLength: length }),
  };
}
function portFixture(body: Readable = Readable.from([Buffer.from('image')])) {
  const put = vi.fn<ReceiptS3Port['put']>(async () => undefined),
    get = vi.fn<ReceiptS3Port['get']>(async () => output(body, 5)),
    remove = vi.fn<ReceiptS3Port['delete']>(async () => undefined);
  return { put, get, delete: remove };
}
afterEach(() => vi.unstubAllEnvs());
describe('private S3 receipt storage without network access', () => {
  it('uses fixed AWS endpoints, strict server configuration and UUID-only private keys', () => {
    expect(
      receiptS3Settings({
        RECEIPTS_BUCKET: settings.bucket,
        AWS_REGION: settings.region,
        RECEIPTS_BUCKET_OWNER: settings.expectedOwner,
      }),
    ).toEqual(settings);
    vi.stubEnv('AWS_ENDPOINT_URL', 'https://untrusted.example');
    expect(receiptS3ClientConfig(settings).endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    expect(receiptS3ClientConfig({ ...settings, region: 'cn-north-1' }).endpoint).toBe(
      'https://s3.cn-north-1.amazonaws.com.cn',
    );
    expect(receiptObjectKey('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'original')).toBe(
      'receipts/v1/source/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.source',
    );
    expect(() => receiptObjectKey('../../private', 'original')).toThrow(ReceiptError);
    expect(() =>
      receiptS3Settings({ RECEIPTS_BUCKET: 'https://evil.example', AWS_REGION: 'us-east-1' }),
    ).toThrow(ReceiptError);
    expect(() =>
      receiptS3Settings({ RECEIPTS_BUCKET: settings.bucket, AWS_REGION: 'us-east-1/../../' }),
    ).toThrow(ReceiptError);
    expect(() =>
      receiptS3Settings({
        RECEIPTS_BUCKET: settings.bucket,
        AWS_REGION: 'us-east-1',
        RECEIPTS_BUCKET_OWNER: 'not-an-account',
      }),
    ).toThrow(ReceiptError);
  });
  it('makes original uploads immutable and normalized writes atomic replacements, never public', async () => {
    const port = portFixture(),
      storage = new S3ReceiptStorage(settings, port),
      id = randomUUID(),
      bytes = Buffer.from('image');
    await storage.put(id, 'original', bytes);
    await storage.put(id, 'normalized', bytes);
    const original = port.put.mock.calls[0]![0],
      normalized = port.put.mock.calls[1]![0];
    expect(original).toMatchObject({
      Bucket: settings.bucket,
      Key: `receipts/v1/source/${id}.source`,
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      CacheControl: 'private, no-store',
      ContentLength: 5,
      ExpectedBucketOwner: settings.expectedOwner,
    });
    expect(original.ACL).toBeUndefined();
    expect(original.ChecksumSHA256).toBeTruthy();
    expect(normalized).toMatchObject({
      Key: `receipts/v1/normalized/${id}.jpg`,
      ContentType: 'image/jpeg',
    });
    expect(normalized.IfNoneMatch).toBeUndefined();
    expect(port.put.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });
  it('rejects oversized input before any SDK call', async () => {
    const port = portFixture(),
      storage = new S3ReceiptStorage(settings, port);
    await expect(
      storage.put(randomUUID(), 'original', Buffer.alloc(RECEIPT_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(port.put).not.toHaveBeenCalled();
  });
  it('maps conditional-write conflicts without leaking provider fields', async () => {
    const port = portFixture(),
      storage = new S3ReceiptStorage(settings, port);
    port.put.mockRejectedValueOnce({
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
      message: 'private-provider-body',
    });
    await expect(storage.put(randomUUID(), 'original', Buffer.from('image'))).rejects.toMatchObject(
      { code: 'RECEIPT_ALREADY_STORED', retryable: false, status: 409 },
    );
    port.put.mockRejectedValueOnce(new Error('private-provider-body'));
    try {
      await storage.put(randomUUID(), 'original', Buffer.from('image'));
      throw new Error('Expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(ReceiptError);
      expect(String(error)).not.toContain('private-provider-body');
    }
  });
  it('reads bounded streaming bytes and detects truncation', async () => {
    const port = portFixture(),
      storage = new S3ReceiptStorage(settings, port);
    expect(await storage.read(randomUUID(), 'normalized')).toEqual(Buffer.from('image'));
    port.get.mockResolvedValueOnce(output(Readable.from([Buffer.from('image')]), 6));
    await expect(storage.read(randomUUID(), 'original')).rejects.toMatchObject({
      code: 'INVALID_STORED_IMAGE',
    });
  });
  it('destroys a body with an oversized declared length before buffering', async () => {
    const body = Readable.from([Buffer.from('image')]),
      port = portFixture(body),
      storage = new S3ReceiptStorage(settings, port);
    port.get.mockResolvedValueOnce(output(body, RECEIPT_MAX_BYTES + 1));
    await expect(storage.read(randomUUID(), 'original')).rejects.toMatchObject({
      code: 'INVALID_STORED_IMAGE',
    });
    expect(body.destroyed).toBe(true);
  });
  it('bounds streamed bytes even when Content-Length is missing or false', async () => {
    const body = Readable.from([Buffer.alloc(RECEIPT_MAX_BYTES), Buffer.from('x')]),
      port = portFixture(body),
      storage = new S3ReceiptStorage(settings, port);
    port.get.mockResolvedValueOnce(output(body));
    await expect(storage.read(randomUUID(), 'original')).rejects.toMatchObject({
      code: 'INVALID_STORED_IMAGE',
    });
    expect(body.destroyed).toBe(true);
  });
  it('terminates a stalled response stream on deadline', async () => {
    const body = new Readable({ read() {} }),
      port = portFixture(body),
      storage = new S3ReceiptStorage(settings, port, 10);
    port.get.mockResolvedValueOnce(output(body));
    await expect(storage.read(randomUUID(), 'original')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      retryable: true,
    });
    expect(body.destroyed).toBe(true);
  });
  it('deletes only the two exact receipt objects and exposes no arbitrary delete keys', async () => {
    const port = portFixture(),
      storage = new S3ReceiptStorage(settings, port),
      id = randomUUID();
    await storage.delete(id);
    expect(port.delete.mock.calls.map((call) => call[0].Key).sort()).toEqual([
      `receipts/v1/normalized/${id}.jpg`,
      `receipts/v1/source/${id}.source`,
    ]);
    await expect(storage.delete('../../private')).rejects.toMatchObject({
      code: 'INVALID_RECEIPT_ID',
    });
    expect(port.delete).toHaveBeenCalledTimes(2);
  });
  it('uses lifecycle expiration for S3 orphans without granting list permission', async () => {
    vi.stubEnv('RECEIPT_STORAGE_DRIVER', 's3');
    vi.stubEnv('RECEIPTS_BUCKET', settings.bucket);
    vi.stubEnv('AWS_REGION', settings.region);
    expect(storageDirectory()).toBe('s3');
    expect(await staleReceiptFiles()).toEqual([]);
    expect(() => receiptPath(randomUUID(), 'original')).toThrow(ReceiptError);
    vi.stubEnv('RECEIPT_STORAGE_DRIVER', 'arbitrary-remote-provider');
    expect(() => storageDirectory()).toThrow(ReceiptError);
  });
  it('preserves explicit filesystem storage and immutable original semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tallie-storage-test-')),
      id = randomUUID();
    try {
      await storeOriginal(id, Buffer.from('first'), directory);
      await expect(storeOriginal(id, Buffer.from('second'), directory)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(receiptPath(id, 'original', directory))).toEqual(Buffer.from('first'));
      await storeNormalized(id, Buffer.from('one'), directory);
      await storeNormalized(id, Buffer.from('two'), directory);
      expect(await readReceiptImage(id, 'normalized', directory)).toEqual(Buffer.from('two'));
      await deleteReceiptFiles(id, directory);
      await expect(readReceiptImage(id, 'original', directory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
