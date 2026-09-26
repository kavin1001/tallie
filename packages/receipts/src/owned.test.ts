import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { sql, type Kysely, type Transaction } from 'kysely';
import { createDatabase, createDemoWorkspace, type Database } from '@tallie/db';
import { lockAccount } from '../../identity/src/database';
import type { AccountPrincipal } from '../../identity/src/contracts';
import { IdentityError } from '../../identity/src/errors';
import { migrate } from '../../db/src/migrate';
import { resolveSession } from '../../../apps/web/src/server/session';
import {
  createReceiptDraft,
  getReceiptDraft,
  getReceiptImage,
} from '../../../apps/web/src/server/receipts/service';
import { createOwnedReceipt, readOwnedReceipt, readOwnedImage } from './owned';
import { processOneReceipt } from './jobs';
import { receiptPath } from './storage';
import { validateProposal } from './schema';
config({ quiet: true });
const proposal = validateProposal({
  title: 'Synthetic dinner',
  currency: 'USD',
  items: [{ description: 'Dinner', quantity: '1', amountMinor: '1000' }],
  subtotalMinor: '1000',
  totalMinor: '1000',
  taxMinor: '0',
  tipMinor: '0',
  discountMinor: '0',
  serviceChargeMinor: '0',
  confidence: 'high',
  concerns: [],
});
const extraction = { proposal, model: 'synthetic-test', inputTokens: 1, outputTokens: 1 };

describe('account-owned receipt authorization and PostgreSQL transactions', () => {
  let db: Kysely<Database>, admin: Pool, directory: string, image: Buffer;
  const schema = `tallie_owned_receipt_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error('Local PostgreSQL is required.');
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Tests require local PostgreSQL.');
    admin = new Pool({ connectionString: connection, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await migrate(url.toString());
    db = createDatabase(url.toString());
    directory = await mkdtemp(join(tmpdir(), 'tallie-owned-receipts-'));
    image = await readFile(new URL('../fixtures/clean-117.png', import.meta.url));
  });
  beforeEach(async () => {
    await db.deleteFrom('receipt_captures').execute();
    await db.deleteFrom('receipt_daily_budget').execute();
    for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function account(
    assurance: 'passkey' | 'onboarding' = 'passkey',
  ): Promise<AccountPrincipal> {
    const userId = randomUUID(),
      sessionId = randomUUID();
    await sql`INSERT INTO auth_user(id,name,email) VALUES(${userId}::uuid,'Synthetic account',${`${userId}@fixture.invalid`})`.execute(
      db,
    );
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${sessionId}::uuid,${userId}::uuid,${randomUUID()},now()+interval '1 hour',${assurance},now())`.execute(
      db,
    );
    return { userId, sessionId, phoneHash: 'synthetic-hash', displayName: 'Synthetic account' };
  }
  const input = () => ({
    contentBase64: image.toString('base64'),
    contentType: 'image/png' as const,
  });
  const upload = (
    principal: AccountPrincipal,
    key = randomUUID(),
    authorize: (tx: Transaction<Database>) => Promise<void> = (tx) => lockAccount(tx, principal),
  ) => createOwnedReceipt(principal.userId, input(), key, authorize, { db, directory });

  it('creates one immutable account draft for concurrent retries and refuses changed bytes', async () => {
    const principal = await account(),
      key = randomUUID();
    const drafts = await Promise.all(Array.from({ length: 8 }, () => upload(principal, key)));
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(1);
    const rows = await db.selectFrom('receipt_captures').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_user_id: principal.userId,
      workspace_id: null,
      person_id: null,
      session_id: null,
    });
    expect(await readdir(directory)).toHaveLength(1);
    await expect(
      createOwnedReceipt(
        principal.userId,
        {
          ...input(),
          contentBase64: Buffer.concat([image, Buffer.from('changed')]).toString('base64'),
        },
        key,
        (tx) => lockAccount(tx, principal),
        { db, directory },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await readFile(receiptPath(drafts[0]!.id, 'original', directory))).toEqual(image);
  });
  it('keeps the same retry key independent across real accounts and denies foreign draft/image reads', async () => {
    const first = await account(),
      second = await account(),
      key = randomUUID();
    const [a, b] = await Promise.all([upload(first, key), upload(second, key)]);
    expect(a.id).not.toBe(b.id);
    await expect(readOwnedReceipt(second.userId, a.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(readOwnedImage(second.userId, a.id, { db, directory })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await processOneReceipt(db, { directory, extract: async () => extraction });
    await processOneReceipt(db, { directory, extract: async () => extraction });
    const ready = await readOwnedReceipt(first.userId, a.id, db);
    expect(ready.imageUrl).toBe(`/api/account-receipts/${a.id}/image`);
    expect((await readOwnedImage(first.userId, a.id, { db, directory })).subarray(0, 3)).toEqual(
      Buffer.from([255, 216, 255]),
    );
    await expect(readOwnedImage(second.userId, a.id, { db, directory })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('never grants real-account access to demo receipts or demo-session access to account receipts', async () => {
    const real = await account(),
      owned = await upload(real);
    const demo = await resolveSession((await createDemoWorkspace(db)).token, db);
    const demoDraft = await createReceiptDraft(demo, input(), randomUUID(), { db, directory });
    await expect(readOwnedReceipt(real.userId, demoDraft.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      readOwnedImage(real.userId, demoDraft.id, { db, directory }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getReceiptDraft(demo, owned.id, db)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getReceiptImage(demo, owned.id, { db, directory })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      db
        .updateTable('receipt_captures')
        .set({ account_user_id: real.userId })
        .where('id', '=', demoDraft.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('authorizes every retry and rejects restricted or revoked sessions before writing files', async () => {
    const restricted = await account('onboarding');
    await expect(upload(restricted)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await readdir(directory)).toEqual([]);
    const principal = await account(),
      key = randomUUID(),
      draft = await upload(principal, key);
    await sql`DELETE FROM auth_session WHERE id=${principal.sessionId}::uuid`.execute(db);
    await expect(upload(principal, key)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await db.selectFrom('receipt_captures').selectAll().execute()).toHaveLength(1);
    expect(await readFile(receiptPath(draft.id, 'original', directory))).toEqual(image);
  });
  it('rolls back authorization-side database changes and performs no storage write after denial', async () => {
    const principal = await account(),
      marker = randomUUID();
    await expect(
      upload(principal, randomUUID(), async (tx) => {
        await lockAccount(tx, principal);
        await sql`INSERT INTO auth_verification(id,identifier,value,expires_at) VALUES(${marker}::uuid,'rollback-fixture','synthetic',now()+interval '1 minute')`.execute(
          tx,
        );
        throw new IdentityError('AUTH_REQUIRED', 'Synthetic denial.', 401);
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(
      (await sql`SELECT id FROM auth_verification WHERE id=${marker}::uuid`.execute(db)).rows,
    ).toEqual([]);
    expect(await db.selectFrom('receipt_captures').select('id').execute()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
  it('holds session authority throughout upload publication against concurrent revocation', async () => {
    const principal = await account();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = upload(principal, randomUUID(), async (tx) => {
      await lockAccount(tx, principal);
      entered();
      await gate;
    });
    await ready;
    try {
      await expect(
        db.transaction().execute(async (tx) => {
          await sql`SET LOCAL lock_timeout='30ms'`.execute(tx);
          await sql`DELETE FROM auth_session WHERE id=${principal.sessionId}::uuid`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
    }
    const draft = await pending;
    expect((await readOwnedReceipt(principal.userId, draft.id, db)).id).toBe(draft.id);
    await sql`DELETE FROM auth_session WHERE id=${principal.sessionId}::uuid`.execute(db);
    await expect(upload(principal)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('cleans a source object after a known database rollback without touching committed inputs', async () => {
    const principal = await account();
    // A nonexistent user passes this deliberately injected callback, then fails the account FK.
    // This forces a real rollback after the source write, exercising its orphan cleanup path.
    await expect(
      createOwnedReceipt(randomUUID(), input(), randomUUID(), async () => undefined, {
        db,
        directory,
      }),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await readdir(directory)).toEqual([]);
    const draft = await upload(principal);
    expect(await readFile(receiptPath(draft.id, 'original', directory))).toEqual(image);
    expect(await db.selectFrom('receipt_captures').select('id').execute()).toHaveLength(1);
  });
  it('preserves a committed source after a simulated lost commit reply, then safely reuses the retry key', async () => {
    const principal = await account(),
      key = randomUUID();
    let loseReply = true;
    const interrupted = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction')
          return () => {
            const builder = target.transaction();
            return {
              execute: async <T>(
                callback: (tx: Transaction<Database>) => Promise<T>,
              ): Promise<T> => {
                const result = await builder.execute(callback);
                if (loseReply) {
                  loseReply = false;
                  throw new Error('Synthetic lost COMMIT reply');
                }
                return result;
              },
            };
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      createOwnedReceipt(principal.userId, input(), key, (tx) => lockAccount(tx, principal), {
        db: interrupted,
        directory,
      }),
    ).rejects.toThrow('Synthetic lost COMMIT reply');
    const row = await db
      .selectFrom('receipt_captures')
      .selectAll()
      .where('account_user_id', '=', principal.userId)
      .where('retry_key', '=', key)
      .executeTakeFirstOrThrow();
    expect(await readFile(receiptPath(row.id, 'original', directory))).toEqual(image);
    expect((await upload(principal, key)).id).toBe(row.id);
    expect(await db.selectFrom('receipt_captures').select('id').execute()).toHaveLength(1);
  });

  it('enforces owner quota across sessions without charging retries and expires all read paths', async () => {
    const principal = await account(),
      key = randomUUID(),
      first = await upload(principal, key);
    await upload(principal, key);
    const sibling = { ...principal, sessionId: randomUUID() };
    await sql`INSERT INTO auth_session(id,user_id,token,expires_at,assurance_kind,assurance_at) VALUES(${sibling.sessionId}::uuid,${principal.userId}::uuid,${randomUUID()},now()+interval '1 hour','passkey',now())`.execute(
      db,
    );
    for (let i = 1; i < 10; i++) await upload(i % 2 ? principal : sibling);
    await expect(upload(sibling)).rejects.toMatchObject({ code: 'RECEIPT_LIMIT_REACHED' });
    await db
      .updateTable('receipt_captures')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', first.id)
      .execute();
    await expect(readOwnedReceipt(principal.userId, first.id, db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      readOwnedImage(principal.userId, first.id, { db, directory }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(upload(principal, key)).rejects.toMatchObject({ code: 'RECEIPT_EXPIRED' });
  });
});
