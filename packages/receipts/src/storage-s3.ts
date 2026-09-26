import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { RECEIPT_MAX_BYTES } from './contracts';
import { ReceiptError } from './errors';

export const S3_STORAGE_LOCATION = 's3';
export type ReceiptImageKind = 'original' | 'normalized';
export interface ReceiptS3Settings {
  bucket: string;
  region: string;
  expectedOwner?: string;
}
/** Small SDK port keeps tests independent of AWS credentials and network access. */
export interface ReceiptS3Port {
  put(input: PutObjectCommand['input'], signal: AbortSignal): Promise<void>;
  get(input: GetObjectCommand['input'], signal: AbortSignal): Promise<GetObjectCommandOutput>;
  delete(input: DeleteObjectCommand['input'], signal: AbortSignal): Promise<void>;
}
export function receiptObjectKey(id: string, kind: ReceiptImageKind): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new ReceiptError('INVALID_RECEIPT_ID', 'Invalid receipt identifier.');
  return `receipts/v1/${kind === 'original' ? 'source' : 'normalized'}/${id}.${kind === 'original' ? 'source' : 'jpg'}`;
}
export function receiptS3Settings(
  env: Record<string, string | undefined> = process.env,
): ReceiptS3Settings {
  const bucket = env.RECEIPTS_BUCKET ?? '',
    region = env.AWS_REGION ?? '',
    expectedOwner = env.RECEIPTS_BUCKET_OWNER;
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.startsWith('xn--') ||
    !/^([a-z]{2,4})(-[a-z0-9]+)+-\d+$/.test(region) ||
    (expectedOwner !== undefined && !/^\d{12}$/.test(expectedOwner))
  )
    throw new ReceiptError(
      'CONFIGURATION_REQUIRED',
      'Private receipt storage is not configured.',
      false,
      503,
    );
  return { bucket, region, ...(expectedOwner ? { expectedOwner } : {}) };
}
export function receiptS3ClientConfig(settings: ReceiptS3Settings): S3ClientConfig {
  // Explicit AWS endpoint prevents environment endpoint overrides or user URLs.
  return {
    region: settings.region,
    endpoint: `https://s3.${settings.region}.${settings.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`,
    forcePathStyle: false,
    followRegionRedirects: false,
    maxAttempts: 2,
  };
}
function sdkPort(settings: ReceiptS3Settings): ReceiptS3Port {
  const client = new S3Client(receiptS3ClientConfig(settings));
  return {
    async put(input, signal) {
      await client.send(new PutObjectCommand(input), { abortSignal: signal });
    },
    get(input, signal) {
      return client.send(new GetObjectCommand(input), { abortSignal: signal });
    },
    async delete(input, signal) {
      await client.send(new DeleteObjectCommand(input), { abortSignal: signal });
    },
  };
}
function safeStorageError(error: unknown): ReceiptError {
  if (error instanceof ReceiptError) return error;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const status = candidate?.$metadata?.httpStatusCode;
  if (status === 412 || candidate?.name === 'PreconditionFailed')
    return new ReceiptError('RECEIPT_ALREADY_STORED', 'This photo is already stored.', false, 409);
  if (status === 404 || candidate?.name === 'NoSuchKey')
    return new ReceiptError(
      'RECEIPT_FILE_MISSING',
      'This photo is no longer available. Upload it again.',
      false,
      404,
    );
  return new ReceiptError(
    'STORAGE_UNAVAILABLE',
    'Private photo storage is temporarily unavailable. Please try again.',
    true,
    503,
  );
}
export class S3ReceiptStorage {
  private readonly port: ReceiptS3Port;
  constructor(
    private readonly settings: ReceiptS3Settings,
    port?: ReceiptS3Port,
    private readonly timeoutMs = 15000,
  ) {
    this.settings = receiptS3Settings({
      RECEIPTS_BUCKET: settings.bucket,
      AWS_REGION: settings.region,
      ...(settings.expectedOwner ? { RECEIPTS_BUCKET_OWNER: settings.expectedOwner } : {}),
    });
    this.port = port ?? sdkPort(this.settings);
  }
  private object(id: string, kind: ReceiptImageKind) {
    return {
      Bucket: this.settings.bucket,
      Key: receiptObjectKey(id, kind),
      ...(this.settings.expectedOwner ? { ExpectedBucketOwner: this.settings.expectedOwner } : {}),
    };
  }
  async put(id: string, kind: ReceiptImageKind, bytes: Buffer): Promise<void> {
    if (!bytes.length || bytes.length > RECEIPT_MAX_BYTES)
      throw new ReceiptError('IMAGE_TOO_LARGE', 'Choose a photo smaller than 8 MB.', false, 413);
    try {
      await this.port.put(
        {
          ...this.object(id, kind),
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: kind === 'normalized' ? 'image/jpeg' : 'application/octet-stream',
          CacheControl: 'private, no-store',
          ServerSideEncryption: 'AES256',
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          ...(kind === 'original' ? { IfNoneMatch: '*' } : {}),
        },
        AbortSignal.timeout(this.timeoutMs),
      );
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async read(id: string, kind: ReceiptImageKind): Promise<Buffer> {
    const controller = new AbortController();
    let body: Readable | undefined,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      body?.destroy(new Error('Receipt storage timeout.'));
    }, this.timeoutMs);
    timer.unref();
    try {
      const response = await this.port.get(this.object(id, kind), controller.signal);
      if (response.Body instanceof Readable) body = response.Body;
      if (
        response.ContentLength !== undefined &&
        (!Number.isSafeInteger(response.ContentLength) ||
          response.ContentLength < 1 ||
          response.ContentLength > RECEIPT_MAX_BYTES)
      )
        throw new ReceiptError(
          'INVALID_STORED_IMAGE',
          'This stored photo is not supported. Upload it again.',
          false,
          413,
        );
      if (!(response.Body instanceof Readable))
        throw new ReceiptError(
          'INVALID_STORED_IMAGE',
          'This stored photo could not be read.',
          false,
          502,
        );
      body = response.Body;
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array))
          throw new ReceiptError(
            'INVALID_STORED_IMAGE',
            'This stored photo could not be read.',
            false,
            502,
          );
        length += chunk.byteLength;
        if (length > RECEIPT_MAX_BYTES) {
          body.destroy();
          throw new ReceiptError(
            'INVALID_STORED_IMAGE',
            'This stored photo is too large. Upload it again.',
            false,
            413,
          );
        }
        chunks.push(Buffer.from(chunk));
      }
      if (timedOut) throw new Error('Receipt storage timeout.');
      if (
        length === 0 ||
        (response.ContentLength !== undefined && length !== response.ContentLength)
      )
        throw new ReceiptError(
          'INVALID_STORED_IMAGE',
          'This stored photo was incomplete. Upload it again.',
          false,
          502,
        );
      return Buffer.concat(chunks, length);
    } catch (error) {
      body?.destroy();
      throw safeStorageError(error);
    } finally {
      clearTimeout(timer);
    }
  }
  async delete(id: string): Promise<void> {
    try {
      await Promise.all(
        (['original', 'normalized'] as const).map((kind) =>
          this.port.delete(this.object(id, kind), AbortSignal.timeout(this.timeoutMs)),
        ),
      );
    } catch (error) {
      throw safeStorageError(error);
    }
  }
}
let cached: { key: string; storage: S3ReceiptStorage } | undefined;
export function receiptS3(): S3ReceiptStorage {
  const settings = receiptS3Settings(),
    key = JSON.stringify(settings);
  if (!cached || cached.key !== key) cached = { key, storage: new S3ReceiptStorage(settings) };
  return cached.storage;
}
