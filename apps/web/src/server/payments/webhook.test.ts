import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  identityDatabase: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('@tallie/identity', () => ({ identityDatabase: mocks.identityDatabase }));
vi.mock('@tallie/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallie/payments')>();
  return {
    ...actual,
    NaturalWebhookInboxService: class {
      constructor(...args: unknown[]) {
        mocks.construct(...args);
      }
      ingest = mocks.ingest;
    },
  };
});
import { naturalWebhook, naturalWebhookConfiguration } from './webhook';
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const productionSecret = `whsec_${randomBytes(32).toString('base64')}`;
const platform = `pty_${'1'.repeat(32)}`;
const agent = `agt_${'2'.repeat(32)}`;
const env = {
  NATURAL_ENVIRONMENT: 'sandbox',
  NATURAL_SANDBOX_WEBHOOK_ENABLED: 'true',
  NATURAL_SANDBOX_WEBHOOK_SECRET: secret,
  NATURAL_PLATFORM_PARTY_ID: platform,
  NATURAL_AGENT_ID: agent,
  IDENTITY_ENCRYPTION_KEY: 'f'.repeat(64),
  NATURAL_PRODUCTION_WEBHOOK_ENABLED: 'true',
  NATURAL_PRODUCTION_WEBHOOK_SECRET: productionSecret,
  NATURAL_PRODUCTION_PLATFORM_PARTY_ID: `pty_${'5'.repeat(32)}`,
  NATURAL_PRODUCTION_AGENT_ID: `agt_${'6'.repeat(32)}`,
};
const context = (environment = 'sandbox') => ({ params: Promise.resolve({ environment }) });
function request(key = secret, overrides: Record<string, string> = {}) {
  const id = `evt_${'3'.repeat(32)}`;
  const resourceId = `pay_${'4'.repeat(32)}`;
  const raw = JSON.stringify({
    id,
    object: 'event',
    type: 'payment.completed',
    resourceId,
    resourceType: 'payment',
    sourcePartyId: platform,
    createdAt: new Date().toISOString(),
    data: { object: { id: resourceId } },
  });
  const now = new Date();
  return new Request('https://tallie.example/api/webhooks/natural/sandbox', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': new Webhook(key).sign(id, now, raw),
      ...overrides,
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.ingest.mockResolvedValue({ duplicate: false, quarantined: false });
  mocks.identityDatabase.mockReturnValue('database');
});
afterEach(() => vi.unstubAllEnvs());
describe('Natural webhook HTTP durable acknowledgement', () => {
  it('acknowledges only after the verified event commits to storage', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.ingest.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started();
        }),
    );
    let done = false;
    const response = naturalWebhook(request(), context()).then((value) => {
      done = true;
      return value;
    });
    await entered;
    expect(done).toBe(false);
    release();
    const saved = await response;
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ received: true });
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(mocks.construct).toHaveBeenCalledExactlyOnceWith(
      'database',
      expect.objectContaining({
        environment: 'sandbox',
        platformPartyId: platform,
        agentId: agent,
      }),
    );
  });
  it('rejects invalid signatures before opening storage', async () => {
    expect((await naturalWebhook(request(productionSecret), context())).status).toBe(401);
    expect(mocks.identityDatabase).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it('uses a separate production secret and identities', async () => {
    expect((await naturalWebhook(request(), context('production'))).status).toBe(401);
    expect((await naturalWebhook(request(productionSecret), context('production'))).status).toBe(
      200,
    );
    expect(mocks.construct).toHaveBeenCalledWith(
      'database',
      expect.objectContaining({
        environment: 'production',
        platformPartyId: env.NATURAL_PRODUCTION_PLATFORM_PARTY_ID,
      }),
    );
  });
  it('returns retryable sanitized failure when storage cannot commit', async () => {
    mocks.ingest.mockRejectedValue(new Error('private provider/SQL/phone detail'));
    const result = await naturalWebhook(request(), context());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'WEBHOOK_STORAGE_UNAVAILABLE' });
  });
  it('acknowledges quarantined and duplicate events only after durable acceptance', async () => {
    mocks.ingest.mockResolvedValue({ duplicate: true, quarantined: true });
    const result = await naturalWebhook(request(), context());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ received: true });
  });
  it.each([{ 'content-type': 'application/jsonp' }, { 'content-encoding': 'gzip' }])(
    'rejects noncanonical body encodings',
    async (headers) => {
      expect((await naturalWebhook(request(secret, headers), context())).status).toBe(415);
      expect(mocks.ingest).not.toHaveBeenCalled();
    },
  );
  it('has no enabled default and refuses unknown environments', async () => {
    vi.stubEnv('NATURAL_SANDBOX_WEBHOOK_ENABLED', 'false');
    expect((await naturalWebhook(request(), context())).status).toBe(503);
    expect((await naturalWebhook(request(), context('live'))).status).toBe(404);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
describe('Natural webhook configuration separation', () => {
  it('rejects accidentally reused sandbox and production signing secrets', () => {
    expect(() =>
      naturalWebhookConfiguration('production', {
        ...env,
        NATURAL_PRODUCTION_WEBHOOK_SECRET: secret,
      }),
    ).toThrow('NATURAL_WEBHOOK_NOT_CONFIGURED');
    expect(() =>
      naturalWebhookConfiguration('sandbox', {
        ...env,
        NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET: secret,
      }),
    ).toThrow('NATURAL_WEBHOOK_NOT_CONFIGURED');
  });
  it('never falls back to a sandbox identity when production fields are missing', () => {
    expect(() =>
      naturalWebhookConfiguration('production', { ...env, NATURAL_PRODUCTION_AGENT_ID: undefined }),
    ).toThrow('NATURAL_WEBHOOK_NOT_CONFIGURED');
  });
  it('requires sandbox credentials to be explicitly marked sandbox', () => {
    expect(() =>
      naturalWebhookConfiguration('sandbox', { ...env, NATURAL_ENVIRONMENT: 'production' }),
    ).toThrow('NATURAL_WEBHOOK_NOT_CONFIGURED');
  });
  it('requires a storage encryption key and strict provider IDs', () => {
    for (const patch of [
      { IDENTITY_ENCRYPTION_KEY: '' },
      { NATURAL_PLATFORM_PARTY_ID: 'pty_bad' },
      { NATURAL_AGENT_ID: 'bad' },
    ])
      expect(() => naturalWebhookConfiguration('sandbox', { ...env, ...patch })).toThrow(
        'NATURAL_WEBHOOK_NOT_CONFIGURED',
      );
  });
});
