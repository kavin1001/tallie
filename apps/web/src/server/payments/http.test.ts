import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxOnboardingError } from '@tallie/payments';
import { AppError } from '../errors';

const mocks = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  service: vi.fn(),
  state: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../identity', () => ({ requireAccount: mocks.requireAccount }));
vi.mock('./service', () => ({ sandboxPaymentsService: mocks.service }));
import { sandboxRoute } from './http';

const origin = 'https://tallie.example';
const actor = { userId: 'account', sessionId: 'session', phoneHash: 'phone', displayName: 'Test' };
const state = {
  environment: 'sandbox',
  available: true,
  moneyMovementEnabled: false,
  connection: null,
};
const request = (method: string, body = '{}', requestOrigin = origin) =>
  new Request(`${origin}/api/payments/sandbox`, {
    method,
    headers: {
      origin: requestOrigin,
      'content-type': 'application/json',
      'x-tallie-account': actor.userId,
    },
    ...(method === 'GET' ? {} : { body }),
  });

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'beta');
  vi.stubEnv('APP_ORIGIN', origin);
  vi.resetAllMocks();
  mocks.requireAccount.mockResolvedValue(actor);
  mocks.service.mockReturnValue(mocks);
  for (const action of ['state', 'start', 'retry', 'refresh'] as const)
    mocks[action].mockResolvedValue(state);
});
afterEach(() => vi.unstubAllEnvs());

describe('sandbox HTTP boundary', () => {
  it('requires real account authentication even for a cached sandbox state', async () => {
    mocks.requireAccount.mockRejectedValue(new AppError('AUTH_REQUIRED', 'Sign in.', 401));
    const response = await sandboxRoute('state')(request('GET'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('forbids cross-origin mutation and browser-supplied provider identities or amounts', async () => {
    expect(
      (await sandboxRoute('start')(request('POST', '{}', 'https://untrusted.invalid'))).status,
    ).toBe(403);
    for (const body of [
      '{"customerPartyId":"pty_untrusted"}',
      '{"amount":100}',
      '{"permissions":["payments.create"]}',
    ])
      expect((await sandboxRoute('start')(request('POST', body))).status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('only invokes the selected command with the server-resolved account and never enables money movement', async () => {
    const response = await sandboxRoute('start')(request('POST'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: state });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns bounded service errors and does not disclose unknown database/provider details', async () => {
    mocks.retry.mockRejectedValue(
      new SandboxOnboardingError(
        'SANDBOX_RETRY_EXPIRED',
        'This test account needs a setup review.',
        409,
      ),
    );
    expect((await sandboxRoute('retry')(request('POST'))).status).toBe(409);
    mocks.state.mockRejectedValue(new Error('credential or private provider body'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await sandboxRoute('state')(request('GET'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('credential');
    vi.restoreAllMocks();
  });
});
