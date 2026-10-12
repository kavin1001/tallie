import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NaturalProviderError } from '@tallie/natural';
import { OwnerPilotError } from '@tallie/payments';
import { AppError } from '../errors';
const mocks = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  service: vi.fn(),
  state: vi.fn(),
  review: vi.fn(),
  confirm: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../identity', () => ({ requireAccount: mocks.requireAccount }));
vi.mock('./owner-pilot', () => ({ ownerPilotService: mocks.service }));
import { ownerPilotRoute } from './owner-pilot-http';

const origin = 'http://localhost:3004';
const actor = { userId: 'account', sessionId: 'session', phoneHash: 'hash', displayName: 'Person' };
const reviewId = '7198faac-354e-4fc8-aeae-8a87c981166d';
const state = {
  available: true,
  recipientHandle: '@fixture_recipient',
  amountMinor: 100,
  currency: 'USD',
  availableMinor: 400,
  review: null,
  transfer: null,
};
type Action = 'state' | 'review' | 'confirm' | 'refresh';
function request(action: Action, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/payments/owner-pilot`, {
    method: action === 'state' ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    ...(action === 'state' ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_MODE', 'beta');
  vi.stubEnv('APP_ORIGIN', origin);
  mocks.requireAccount.mockResolvedValue(actor);
  mocks.service.mockReturnValue(mocks);
  mocks.state.mockResolvedValue(state);
  mocks.review.mockResolvedValue(state);
  mocks.confirm.mockResolvedValue(state);
  mocks.refresh.mockResolvedValue(state);
});
afterEach(() => vi.unstubAllEnvs());

describe('owner pilot HTTP authority boundary', () => {
  it('reads private state using the resolved account and no mutations', async () => {
    const response = await ownerPilotRoute('state')(request('state'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ data: state });
    expect(mocks.service).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each(['state', 'review', 'confirm', 'refresh'] as const)(
    'rejects unauthenticated %s before service construction',
    async (action) => {
      mocks.requireAccount.mockRejectedValue(new AppError('AUTH_REQUIRED', 'Sign in first.', 401));
      expect((await ownerPilotRoute(action)(request(action, { reviewId }))).status).toBe(401);
      expect(mocks.service).not.toHaveBeenCalled();
    },
  );

  it('requires strict same-origin JSON before any mutation work', async () => {
    for (const action of ['review', 'confirm', 'refresh'] as const) {
      for (const headers of [
        { origin: 'https://evil.example' },
        { 'sec-fetch-site': 'cross-site' },
      ])
        expect((await ownerPilotRoute(action)(request(action, { reviewId }, headers))).status).toBe(
          403,
        );
      expect(
        (await ownerPilotRoute(action)(request(action, {}, { 'content-type': 'text/plain' })))
          .status,
      ).toBe(415);
    }
    expect(mocks.requireAccount).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('does not let review or refresh select source, identity, amount or recipient', async () => {
    for (const action of ['review', 'refresh'] as const)
      for (const body of [
        { userId: 'another-account' },
        { phoneHash: 'fake' },
        { walletId: 'wal_fake' },
        { agentId: 'agt_fake' },
        { platformPartyId: 'pty_fake' },
        { recipientHandle: '@other' },
        { amountMinor: 1 },
        { enabled: true },
        { reviewId },
        null,
        [],
      ])
        expect((await ownerPilotRoute(action)(request(action, body))).status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('confirms only one valid review ID and supplies the authenticated actor', async () => {
    expect((await ownerPilotRoute('confirm')(request('confirm', { reviewId }))).status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(actor, reviewId);
    for (const body of [
      {},
      { reviewId: 'bad' },
      { reviewId, amountMinor: 2 },
      { reviewId, recipientHandle: '@other' },
      { reviewId, walletId: 'wal_other' },
      { reviewId, operationId: 'op_other' },
      { reviewId, idempotencyKey: 'fresh-key' },
    ])
      expect((await ownerPilotRoute('confirm')(request('confirm', body))).status).toBe(400);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and oversized JSON without using payment authority', async () => {
    const malformed = new Request(`${origin}/api/payments/owner-pilot/review`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{',
    });
    expect((await ownerPilotRoute('review')(malformed)).status).toBe(400);
    expect(
      (await ownerPilotRoute('review')(request('review', {}, { 'content-length': '65537' })))
        .status,
    ).toBe(413);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('preserves strict passkey rejection and the disabled pilot boundary', async () => {
    mocks.review.mockRejectedValue(new OwnerPilotError('OWNER_PILOT_PASSKEY_REQUIRED', 401));
    const response = await ownerPilotRoute('review')(request('review'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'OWNER_PILOT_PASSKEY_REQUIRED' },
    });
    mocks.service.mockImplementation(() => {
      throw new AppError('OWNER_PILOT_DISABLED', 'Unavailable.', 503);
    });
    expect((await ownerPilotRoute('confirm')(request('confirm', { reviewId }))).status).toBe(503);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('maps provider failures without exposing provider codes, identifiers or secret content', async () => {
    const error = new NaturalProviderError('binding_mismatch', 'unknown', 403);
    error.message = 'ak_ntl_prod_do_not_expose pty_private +12025550101';
    mocks.confirm.mockRejectedValue(error);
    const response = await ownerPilotRoute('confirm')(request('confirm', { reviewId }));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('OWNER_PILOT_PROVIDER_UNAVAILABLE');
    expect(body).not.toContain('ak_ntl_');
    expect(body).not.toContain('pty_private');
    expect(body).not.toContain('+12025550101');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
