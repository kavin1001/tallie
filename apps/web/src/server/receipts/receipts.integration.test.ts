import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createDatabase, createDemoWorkspace, tokenHash, type Database } from '@tallie/db';
import type { Kysely } from 'kysely';
import { ReceiptError, validateProposal } from '@tallie/receipts';
import {
  claimReceiptJob,
  finishReceiptJob,
  processOneReceipt,
  purgeExpiredReceipts,
  reserveProviderAttempt,
} from '@tallie/receipts/jobs';
import { receiptPath } from '@tallie/receipts/storage';
import { migrate } from '../../../../../packages/db/src/migrate';
import { resolveSession, type Principal } from '../session';
import { createReceiptDraft, getReceiptDraft, getReceiptImage } from './service';

config({ quiet: true });

const proposal = validateProposal({
  title: 'Synthetic dinner',
  currency: 'USD',
  items: [{ description: 'Food', quantity: '1', amountMinor: '1000' }],
  subtotalMinor: '1000',
  totalMinor: '1000',
  taxMinor: '0',
  tipMinor: '0',
  discountMinor: '0',
  serviceChargeMinor: '0',
  confidence: 'high',
  concerns: [],
});
const extraction = { proposal, model: 'synthetic-local-test', inputTokens: 10, outputTokens: 10 };

describe('private receipt jobs against PostgreSQL', () => {
  let db: Kysely<Database>;
  let admin: Pool;
  let directory: string;
  let image: Buffer;
  const schema = `tallie_receipt_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error('Local PostgreSQL is required.');
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Receipt tests only use disposable schemas on local PostgreSQL.');
    process.env.APP_MODE = 'demo';
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString());
    directory = await mkdtemp(join(tmpdir(), 'tallie-receipt-tests-'));
    image = await readFile(
      new URL('../../../../../packages/receipts/fixtures/clean-117.png', import.meta.url),
    );
  });
  beforeEach(async () => {
    await db.deleteFrom('receipt_captures').execute();
    await db.deleteFrom('receipt_daily_budget').execute();
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function owner() {
    return resolveSession((await createDemoWorkspace(db)).token, db);
  }
  async function upload(principal: Principal, key = randomUUID()) {
    return createReceiptDraft(
      principal,
      { contentBase64: image.toString('base64'), contentType: 'image/png' },
      key,
      { db, directory },
    );
  }
  async function sibling(principal: Principal, personId = principal.personId) {
    const sessionId = randomUUID();
    await db
      .insertInto('demo_sessions')
      .values({
        id: sessionId,
        workspace_id: principal.workspaceId,
        person_id: personId,
        token_hash: tokenHash(randomBytes(32).toString('base64url')),
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
      })
      .execute();
    return { ...principal, sessionId, personId };
  }

  it('concurrent retries publish one job and reject changed payload', async () => {
    const principal = await owner();
    const key = randomUUID();
    const drafts = await Promise.all(Array.from({ length: 8 }, () => upload(principal, key)));
    expect(new Set(drafts.map((d) => d.id)).size).toBe(1);
    expect(await db.selectFrom('receipt_captures').selectAll().execute()).toHaveLength(1);
    const different = Buffer.concat([image, Buffer.from('different')]);
    await expect(
      createReceiptDraft(
        principal,
        { contentBase64: different.toString('base64'), contentType: 'image/png' },
        key,
        { db, directory },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('denies unrelated workspace, person, session and revoked session reads', async () => {
    const principal = await owner();
    const draft = await upload(principal);
    const other = await owner();
    const peer = await db
      .selectFrom('people')
      .select('id')
      .where('workspace_id', '=', principal.workspaceId)
      .where('id', '!=', principal.personId)
      .executeTakeFirstOrThrow();
    for (const denied of [other, await sibling(principal), await sibling(principal, peer.id)]) {
      await expect(getReceiptDraft(denied, draft.id, db)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(getReceiptImage(denied, draft.id, { db, directory })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    await db
      .updateTable('demo_sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', principal.sessionId)
      .execute();
    await expect(getReceiptDraft(principal, draft.id, db)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
  it('separate worker produces a private normalized preview and cannot create payments', async () => {
    const principal = await owner();
    const draft = await upload(principal);
    await expect(getReceiptImage(principal, draft.id, { db, directory })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const before = await db.selectFrom('operations').selectAll().execute();
    expect(await processOneReceipt(db, { directory, extract: async () => extraction })).toBe(true);
    const result = await getReceiptDraft(principal, draft.id, db);
    expect(result.status).toBe('review_needed');
    expect(result.proposal?.totalMinor).toBe('1000');
    const preview = await getReceiptImage(principal, draft.id, { db, directory });
    expect(preview.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect(await db.selectFrom('operations').selectAll().execute()).toHaveLength(before.length);
  });
  it('concurrent claims select each pending job once', async () => {
    const principal = await owner();
    await upload(principal);
    await upload(principal);
    const claims = (await Promise.all(Array.from({ length: 6 }, () => claimReceiptJob(db)))).filter(
      (v) => v !== null,
    );
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((v) => v.id)).size).toBe(2);
  });
  it('reclaims expired leases and fences late completion from the previous worker', async () => {
    const principal = await owner();
    const draft = await upload(principal);
    const first = await claimReceiptJob(db);
    expect(first).not.toBeNull();
    await db
      .updateTable('receipt_captures')
      .set({ lease_until: new Date(Date.now() - 1_000) })
      .where('id', '=', draft.id)
      .execute();
    const second = await claimReceiptJob(db);
    expect(second?.attempts).toBe(2);
    expect(
      await finishReceiptJob(db, draft.id, first!.lease_token, extraction, 'a'.repeat(64)),
    ).toBe(false);
    expect(
      await finishReceiptJob(db, draft.id, second!.lease_token, extraction, 'b'.repeat(64)),
    ).toBe(true);
  });
  it('allows one transient retry and stops after the second failure', async () => {
    const principal = await owner();
    const draft = await upload(principal);
    let attempts = 0;
    const extract = async () => {
      attempts++;
      throw new ReceiptError('PROVIDER_INTERRUPTED', 'Local test', true);
    };
    await processOneReceipt(db, { directory, extract });
    expect((await getReceiptDraft(principal, draft.id, db)).status).toBe('queued');
    await db
      .updateTable('receipt_captures')
      .set({ available_at: new Date(Date.now() - 1_000) })
      .where('id', '=', draft.id)
      .execute();
    await processOneReceipt(db, { directory, extract });
    expect((await getReceiptDraft(principal, draft.id, db)).status).toBe('failed');
    expect(await processOneReceipt(db, { directory, extract })).toBe(false);
    expect(attempts).toBe(2);
  });
  it('enforces the provider attempt budget atomically under concurrency', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 85 }, () => reserveProviderAttempt(db)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(80);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
  });
  it('enforces workspace and global upload quotas without charging retries', async () => {
    const owners = await Promise.all(Array.from({ length: 6 }, () => owner()));
    for (const principal of owners.slice(0, 5)) {
      const key = randomUUID();
      await upload(principal, key);
      await upload(principal, key);
      for (let i = 1; i < 10; i++) await upload(principal);
      await expect(upload(principal)).rejects.toMatchObject({ code: 'RECEIPT_LIMIT_REACHED' });
    }
    await expect(upload(owners[5]!)).rejects.toMatchObject({ code: 'RECEIPT_LIMIT_REACHED' });
    expect(await db.selectFrom('receipt_captures').selectAll().execute()).toHaveLength(50);
  });
  it('expires access immediately and purges source, normalized image and extracted data', async () => {
    const principal = await owner();
    const draft = await upload(principal);
    await processOneReceipt(db, { directory, extract: async () => extraction });
    await db
      .updateTable('receipt_captures')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', draft.id)
      .execute();
    await expect(getReceiptDraft(principal, draft.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await purgeExpiredReceipts(db, directory)).toBe(1);
    await expect(readFile(receiptPath(draft.id, 'original', directory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(receiptPath(draft.id, 'normalized', directory))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (
        await db
          .selectFrom('receipt_captures')
          .select('proposal')
          .where('id', '=', draft.id)
          .executeTakeFirstOrThrow()
      ).proposal,
    ).toBeNull();
  });

  it('cleans stale orphan files from interrupted commits while preserving unexpected files', async () => {
    const orphan = receiptPath(randomUUID(), 'original', directory);
    const unrelated = join(directory, 'operator-note.txt');
    await writeFile(orphan, 'synthetic orphan');
    await writeFile(unrelated, 'keep');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await utimes(unrelated, old, old);
    await purgeExpiredReceipts(db, directory);
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });
});
