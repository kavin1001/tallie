import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReceiptError } from './errors';
import { receiptS3, receiptS3Settings, S3_STORAGE_LOCATION } from './storage-s3';

export function storageDirectory(): string {
  const driver = process.env.RECEIPT_STORAGE_DRIVER ?? 'filesystem';
  if (driver === 's3') {
    receiptS3Settings();
    return S3_STORAGE_LOCATION;
  }
  if (driver !== 'filesystem')
    throw new ReceiptError(
      'CONFIGURATION_REQUIRED',
      'Receipt storage driver is not supported.',
      false,
      503,
    );
  const directory = process.env.RECEIPT_STORAGE_DIR;
  if (!directory || !isAbsolute(directory))
    throw new ReceiptError('CONFIGURATION_REQUIRED', 'Receipt storage is not configured.');
  return directory;
}

export function receiptPath(
  id: string,
  kind: 'original' | 'normalized',
  directory = storageDirectory(),
): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new ReceiptError('INVALID_RECEIPT_ID', 'Invalid receipt identifier.');
  if (!isAbsolute(directory))
    throw new ReceiptError('CONFIGURATION_REQUIRED', 'A local receipt directory is required.');
  return join(
    /* turbopackIgnore: true */ directory,
    `${id}.${kind === 'original' ? 'source' : 'jpg'}`,
  );
}

export async function storeOriginal(
  id: string,
  bytes: Buffer,
  directory = storageDirectory(),
): Promise<void> {
  if (directory === S3_STORAGE_LOCATION) return receiptS3().put(id, 'original', bytes);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(receiptPath(id, 'original', directory), bytes, { flag: 'wx', mode: 0o600 });
}

export async function storeNormalized(
  id: string,
  bytes: Buffer,
  directory = storageDirectory(),
): Promise<void> {
  if (directory === S3_STORAGE_LOCATION) return receiptS3().put(id, 'normalized', bytes);
  const path = receiptPath(id, 'normalized', directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readReceiptImage(
  id: string,
  kind: 'original' | 'normalized',
  directory = storageDirectory(),
): Promise<Buffer> {
  if (directory === S3_STORAGE_LOCATION) return receiptS3().read(id, kind);
  return readFile(/* turbopackIgnore: true */ receiptPath(id, kind, directory));
}

export async function deleteReceiptFiles(
  id: string,
  directory = storageDirectory(),
): Promise<void> {
  if (directory === S3_STORAGE_LOCATION) return receiptS3().delete(id);
  await Promise.all([
    rm(receiptPath(id, 'original', directory), { force: true }),
    rm(receiptPath(id, 'normalized', directory), { force: true }),
  ]);
}

/** Only our UUID-named stale files are eligible; unexpected files are never touched. */
export async function staleReceiptFiles(
  directory = storageDirectory(),
): Promise<{ id: string; path: string }[]> {
  // S3 orphan retention is enforced by a bucket lifecycle rule. No broad listing permission.
  if (directory === S3_STORAGE_LOCATION) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const stale: { id: string; path: string }[] = [];
  for (const name of names) {
    const match =
      /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:source|jpg(?:\.[a-f0-9-]{36}\.tmp)?)$/.exec(
        name,
      );
    if (!match?.[1]) continue;
    const path = join(/* turbopackIgnore: true */ directory, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.mtimeMs < Date.now() - 24 * 60 * 60 * 1_000)
      stale.push({ id: match[1], path });
    if (stale.length >= 100) break;
  }
  return stale;
}

export async function removeStaleReceiptFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
