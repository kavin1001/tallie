import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appOrigin, serviceConfiguration } from '../../../scripts/run-service.mjs';
import { supervisePreview } from '../../../scripts/start-preview';
import { cleanupExpiredIdentityProofs } from '../../identity/src/security';
import type { IdentityDatabase } from '../../identity/src/database';
import { migrate } from './migrate';

config({ quiet: true });

function childProcess(ignoreTerminate = false) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (_signal?: NodeJS.Signals | number): boolean => true,
  });
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (!ignoreTerminate || signal === 'SIGKILL') {
      queueMicrotask(() => {
        child.signalCode = signal as NodeJS.Signals;
        child.emit('exit', null, signal);
      });
    }
    return true;
  });
  return child as ChildProcess;
}

describe('free preview runtime boundaries', () => {
  const configuration = {
    APP_MODE: 'beta',
    DATABASE_URL: 'postgresql://example.invalid/preview',
    BETTER_AUTH_SECRET: 'auth-secret',
    IDENTITY_ENCRYPTION_KEY: 'identity-key',
    SENDBLUE_API_KEY_ID: 'verification-key',
    SENDBLUE_API_SECRET_KEY: 'verification-secret',
    SENDBLUE_VERIFY_SERVICE_SID: 'verification-service',
    SENDBLUE_FROM_NUMBER: '+12025550123',
    MESSAGING_ENCRYPTION_KEY: 'message-key',
    SENDBLUE_MESSAGE_WEBHOOK_SECRET: 'webhook-secret',
    AWS_SECRET_ACCESS_KEY: 'storage-secret',
    OPENAI_API_KEY: 'receipt-secret',
    NATURAL_API_KEY: 'payment-secret',
  };
  const platform = {
    ...configuration,
    RENDER: 'true',
    RENDER_EXTERNAL_URL: 'https://temporary-unique-host.onrender.com',
  };

  it('derives the temporary origin only from valid trusted Render configuration', () => {
    expect(appOrigin({}, platform)).toBe(platform.RENDER_EXTERNAL_URL);
    expect(appOrigin({ RENDER_EXTERNAL_URL: platform.RENDER_EXTERNAL_URL }, {})).toBeUndefined();
    for (const invalid of [
      'http://temporary.onrender.com',
      'https://user:password@temporary.onrender.com',
      'https://temporary.onrender.com/path',
      'https://temporary.onrender.com?token=secret',
      'https://temporary.onrender.com#fragment',
      'https://temporary.onrender.com.evil.test',
      'not a URL',
    ])
      expect(() => appOrigin({}, { ...platform, RENDER_EXTERNAL_URL: invalid })).toThrow();
    expect(appOrigin({ APP_ORIGIN: 'https://tallie.example' }, platform)).toBe(
      'https://tallie.example',
    );
    expect(() => appOrigin({ APP_ORIGIN: 'http://public.example' }, platform)).toThrow();
  });

  it('removes inherited receipt, message and payment capabilities while retaining signup', () => {
    const { environment } = serviceConfiguration('web-preview', configuration, platform);
    expect(environment.APP_ORIGIN).toBe(platform.RENDER_EXTERNAL_URL);
    expect(environment.APP_HOST).toBe('0.0.0.0');
    expect(environment.RECEIPTS_ENABLED).toBe('false');
    expect(environment.MESSAGING_SEND_ENABLED).toBe('false');
    expect(environment.SENDBLUE_API_SECRET_KEY).toBe(configuration.SENDBLUE_API_SECRET_KEY);
    expect(environment.SENDBLUE_VERIFY_SERVICE_SID).toBe(configuration.SENDBLUE_VERIFY_SERVICE_SID);
    for (const forbidden of [
      'SENDBLUE_FROM_NUMBER',
      'MESSAGING_ENCRYPTION_KEY',
      'SENDBLUE_MESSAGE_WEBHOOK_SECRET',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'NATURAL_API_KEY',
      'RECEIPT_STORAGE_DIR',
    ])
      expect(environment).not.toHaveProperty(forbidden);
    for (const enabling of [
      { APP_MODE: 'demo' },
      { RECEIPTS_ENABLED: 'true' },
      { MESSAGING_SEND_ENABLED: 'true' },
    ])
      expect(() =>
        serviceConfiguration('web-preview', { ...configuration, ...enabling }, platform),
      ).toThrow();
    expect(
      serviceConfiguration('core-worker', configuration, platform).environment,
    ).not.toHaveProperty('SENDBLUE_API_SECRET_KEY');
    expect(
      serviceConfiguration('receipt-worker', configuration, platform).environment,
    ).not.toHaveProperty('IDENTITY_ENCRYPTION_KEY');
    expect(
      serviceConfiguration('messaging-worker', configuration, platform).environment,
    ).not.toHaveProperty('BETTER_AUTH_SECRET');
  });

  it('scopes phone-only authentication to an explicitly enabled preview role', () => {
    const enabled = {
      ...configuration,
      APP_PREVIEW_MODE: 'true',
      IDENTITY_PHONE_DEMO_ENABLED: 'true',
    };
    const inherited = { ...platform, ...enabled };
    const preview = serviceConfiguration('web-preview', enabled, inherited).environment;
    expect(preview.APP_PREVIEW_MODE).toBe('true');
    expect(preview.IDENTITY_PHONE_DEMO_ENABLED).toBe('true');
    expect(preview.RECEIPTS_ENABLED).toBe('false');
    expect(preview.MESSAGING_SEND_ENABLED).toBe('false');
    for (const role of [
      'web-dev',
      'web-start',
      'core-worker',
      'receipt-worker',
      'messaging-worker',
    ]) {
      const environment = serviceConfiguration(role, enabled, inherited).environment;
      expect(environment).not.toHaveProperty('APP_PREVIEW_MODE');
      expect(environment).not.toHaveProperty('IDENTITY_PHONE_DEMO_ENABLED');
    }
    for (const value of [undefined, 'false', 'TRUE', '1'])
      expect(
        serviceConfiguration(
          'web-preview',
          { ...configuration, IDENTITY_PHONE_DEMO_ENABLED: value },
          platform,
        ).environment.IDENTITY_PHONE_DEMO_ENABLED,
      ).toBe('false');
  });

  it('passes sandbox credentials only to explicitly enabled web roles and rejects production credentials', () => {
    const sandbox = {
      ...configuration,
      NATURAL_SANDBOX_ENABLED: 'true',
      NATURAL_ENVIRONMENT: 'sandbox',
      NATURAL_API_KEY: 'sk_ntl_sandbox_synthetic_only',
      NATURAL_AGENT_KEY: 'ak_ntl_sandbox_synthetic_only',
      NATURAL_AGENT_ID: `agt_${'1'.repeat(32)}`,
      NATURAL_PLATFORM_PARTY_ID: `pty_${'2'.repeat(32)}`,
    };
    for (const role of ['web-preview', 'web-dev', 'web-start']) {
      const runtime = serviceConfiguration(role, sandbox, platform).environment;
      expect(runtime.NATURAL_API_KEY).toBe(sandbox.NATURAL_API_KEY);
      expect(runtime.NATURAL_AGENT_KEY).toBe(sandbox.NATURAL_AGENT_KEY);
      expect(runtime.NATURAL_SANDBOX_ENABLED).toBe('true');
      for (const patch of [
        { NATURAL_API_KEY: 'sk_ntl_prod_synthetic_only' },
        { NATURAL_AGENT_KEY: 'ak_ntl_prod_synthetic_only' },
        { NATURAL_ENVIRONMENT: 'production' },
        { NATURAL_AGENT_ID: '' },
        { NATURAL_API_BASE_URL: 'https://api.natural.com' },
      ])
        expect(() => serviceConfiguration(role, { ...sandbox, ...patch }, platform)).toThrow();
    }
    for (const role of ['core-worker', 'receipt-worker', 'messaging-worker']) {
      const runtime = serviceConfiguration(role, sandbox, { ...platform, ...sandbox }).environment;
      expect(Object.keys(runtime).filter((key) => key.startsWith('NATURAL_'))).toEqual([]);
    }
    const disabled = serviceConfiguration(
      'web-preview',
      { ...sandbox, NATURAL_SANDBOX_ENABLED: 'false' },
      { ...platform, ...sandbox },
    ).environment;
    expect(Object.keys(disabled).filter((key) => key.startsWith('NATURAL_'))).toEqual([]);
  });

  it('never starts serving after a failed migration and closes its database', async () => {
    const launchWeb = vi.fn(() => childProcess());
    const close = vi.fn(async () => {});
    const cleanup = vi.fn(async () => 0);
    await expect(
      supervisePreview({
        signal: new AbortController().signal,
        migrate: async () => {
          throw new Error('Migration failed');
        },
        cleanup,
        launchWeb,
        close,
        log: vi.fn(),
      }),
    ).rejects.toThrow('Migration failed');
    expect(launchWeb).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cleans before serving, serializes periodic cleanup and terminates gracefully', async () => {
    const controller = new AbortController();
    const child = childProcess();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let cleanups = 0;
    const cleanup = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push('cleanup');
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      cleanups += 1;
      return 0;
    };
    const close = vi.fn(async () => {});
    const run = supervisePreview({
      signal: controller.signal,
      migrate: async () => {
        order.push('migrate');
      },
      cleanup,
      launchWeb: () => {
        order.push('serve');
        return child;
      },
      close,
      log: vi.fn(),
      maintenanceIntervalMs: 5,
    });
    await vi.waitFor(() => expect(cleanups).toBeGreaterThanOrEqual(3));
    controller.abort();
    expect(await run).toBe(0);
    expect(order.slice(0, 3)).toEqual(['migrate', 'cleanup', 'serve']);
    expect(maximumActive).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
    const lastCount = cleanups;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleanups).toBe(lastCount);
  });

  it('keeps failed maintenance bounded and escalates shutdown for an unresponsive web process', async () => {
    const controller = new AbortController();
    const child = childProcess(true);
    const log = vi.fn();
    let calls = 0;
    const run = supervisePreview({
      signal: controller.signal,
      migrate: async () => {},
      cleanup: async () => {
        calls += 1;
        if (calls > 1) throw new Error('Sensitive database details must not be logged.');
        return 0;
      },
      launchWeb: () => child,
      close: async () => {},
      log,
      maintenanceIntervalMs: 5,
      shutdownTimeoutMs: 10,
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    controller.abort();
    expect(await run).toBe(0);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Sensitive database');
  });

  it('reports unexpected web exit and does not start web after interrupted startup', async () => {
    const child = childProcess();
    const close = vi.fn(async () => {});
    const first = supervisePreview({
      signal: new AbortController().signal,
      migrate: async () => {},
      cleanup: async () => 0,
      launchWeb: () => {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      },
      close,
      log: vi.fn(),
    });
    expect(await first).toBe(1);
    const controller = new AbortController();
    const launchWeb = vi.fn(() => childProcess());
    expect(
      await supervisePreview({
        signal: controller.signal,
        migrate: async () => {
          controller.abort();
        },
        cleanup: async () => 0,
        launchWeb,
        close,
        log: vi.fn(),
      }),
    ).toBe(0);
    expect(launchWeb).not.toHaveBeenCalled();
  });
});

describe('preview startup PostgreSQL guarantees', () => {
  const schema = `tallie_preview_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<IdentityDatabase>;
  let connection: string;
  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('Local PostgreSQL is required.');
    const url = new URL(base);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Tests require local PostgreSQL.');
    admin = new Pool({ connectionString: base, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    connection = url.toString();
    await Promise.all([migrate(connection), migrate(connection)]);
    db = new Kysely<IdentityDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: connection, max: 1 }) }),
    });
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('caps a cleanup batch and preserves live proof secrets', async () => {
    const now = new Date();
    const rows = Array.from({ length: 1006 }, (_, index) => ({
      id: randomUUID(),
      browser_hash: `browser_${index}`,
      idempotency_key: `attempt_${index}`,
      phone_hash: 'synthetic-hash',
      phone_ciphertext: 'synthetic-ciphertext',
      masked_phone: '••• 0123',
      service_sid: 'synthetic-service',
      status: 'pending' as const,
      created_at: new Date(now.getTime() - 600_000),
      expires_at: new Date(now.getTime() + (index === 1005 ? 600_000 : -60_000)),
    }));
    await db.insertInto('identity_signup_transactions').values(rows).execute();
    expect(await cleanupExpiredIdentityProofs(db, now)).toBe(1000);
    expect(await cleanupExpiredIdentityProofs(db, now)).toBe(5);
    expect(await cleanupExpiredIdentityProofs(db, now)).toBe(0);
    const active = await db
      .selectFrom('identity_signup_transactions')
      .select(['status', 'phone_ciphertext'])
      .where('id', '=', rows[1005]!.id)
      .executeTakeFirstOrThrow();
    expect(active).toEqual({ status: 'pending', phone_ciphertext: 'synthetic-ciphertext' });
  });

  it('bounds startup contention on the existing migration advisory lock', async () => {
    const holder = await admin.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(726512031)');
      await expect(
        migrate(connection, {
          connectionTimeoutMillis: 1000,
          statementTimeoutMillis: 1000,
          lockTimeoutMillis: 100,
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(726512031)');
      holder.release();
    }
    await expect(migrate(connection)).resolves.toBeUndefined();
  });
});
