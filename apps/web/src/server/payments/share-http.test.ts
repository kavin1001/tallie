import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxSendError } from '@tallie/payments';
import { AppError } from '../errors';

const mocks = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  service: vi.fn(),
  shareState: vi.fn(),
  reviewShare: vi.fn(),
  confirmShare: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../identity', () => ({ requireAccount: mocks.requireAccount }));
vi.mock('./send-service', () => ({ sandboxSendService: mocks.service }));
import { sandboxShareRoute } from './share-http';

const origin = 'https://tallie.example';
const shareId = '11111111-1111-4111-8111-111111111111';
const reviewId = '22222222-2222-4222-8222-222222222222';
const requestKey = '33333333-3333-4333-8333-333333333333';
const actor = { userId: 'account', sessionId: 'session', phoneHash: 'phone', displayName: 'Test' };
const context = (id = shareId) => ({ params: Promise.resolve({ shareId: id }) });
const state = { shareId, status: 'available' };
const review = { review: { id: reviewId, amountMinor: '2500', recipientName: 'Friend' } };
const transfer = { transfer: { id: 'transfer', reviewId, status: 'PROCESSING' } };
function request(
  action: 'state' | 'review' | 'confirm',
  body: unknown = action === 'confirm' ? { reviewId } : {},
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/payments/sandbox/shares/${shareId}`, {
    method: action === 'state' ? 'GET' : 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': requestKey,
      ...headers,
    },
    ...(action === 'state' ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'beta');
  vi.stubEnv('APP_ORIGIN', origin);
  vi.resetAllMocks();
  mocks.requireAccount.mockResolvedValue(actor);
  mocks.service.mockReturnValue(mocks);
  mocks.shareState.mockResolvedValue(state);
  mocks.reviewShare.mockResolvedValue(review);
  mocks.confirmShare.mockResolvedValue(transfer);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sandbox share repayment HTTP boundary', () => {
  it('reads only the URL share for the authenticated account without cache', async () => {
    const response = await sandboxShareRoute('state')(request('state'), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: state });
    expect(mocks.shareState).toHaveBeenCalledExactlyOnceWith(actor, shareId);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.reviewShare).not.toHaveBeenCalled();
    expect(mocks.confirmShare).not.toHaveBeenCalled();
  });

  it.each(['state', 'review', 'confirm'] as const)(
    'authenticates %s before accessing the payment service',
    async (action) => {
      mocks.requireAccount.mockRejectedValue(new AppError('AUTH_REQUIRED', 'Sign in.', 401));
      const response = await sandboxShareRoute(action)(request(action), context());
      expect(response.status).toBe(401);
      expect(mocks.service).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed share route before accessing the payment service', async () => {
    const response = await sandboxShareRoute('state')(request('state'), context('not-a-share'));
    expect(response.status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('builds a review using the URL share and stable retry key without caller payment details', async () => {
    const response = await sandboxShareRoute('review')(request('review'), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: review });
    expect(mocks.reviewShare).toHaveBeenCalledExactlyOnceWith(actor, { shareId }, requestKey);
    expect(mocks.confirmShare).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied share, recipient, amount, or provider identities on review', async () => {
    for (const body of [
      { shareId },
      { amountMinor: '1' },
      { recipientAccountId: 'another-account' },
      { customerPartyId: 'pty_untrusted' },
      { walletId: 'wal_untrusted' },
    ]) {
      const response = await sandboxShareRoute('review')(request('review', body), context());
      expect(response.status).toBe(400);
    }
    expect(mocks.reviewShare).not.toHaveBeenCalled();
  });

  it('requires a UUID review retry key', async () => {
    for (const key of ['', 'well_formed_but_not_uuid']) {
      const response = await sandboxShareRoute('review')(
        request('review', {}, { 'idempotency-key': key }),
        context(),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.reviewShare).not.toHaveBeenCalled();
  });

  it('passes both URL share and exact review to the share-bound confirmation service', async () => {
    const response = await sandboxShareRoute('confirm')(request('confirm'), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: transfer });
    expect(mocks.confirmShare).toHaveBeenCalledExactlyOnceWith(actor, { shareId, reviewId });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('preserves a service denial when the review belongs to another share', async () => {
    mocks.confirmShare.mockRejectedValue(
      new SandboxSendError('REVIEW_NOT_FOUND', 'This review is unavailable.', 404),
    );
    const response = await sandboxShareRoute('confirm')(request('confirm'), context());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('REVIEW_NOT_FOUND');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('requires one UUID review ID and refuses changed payment details on confirmation', async () => {
    for (const body of [
      {},
      { reviewId: 'invalid' },
      { reviewId, amountMinor: '1' },
      { reviewId, shareId },
    ]) {
      const response = await sandboxShareRoute('confirm')(request('confirm', body), context());
      expect(response.status).toBe(400);
    }
    expect(mocks.confirmShare).not.toHaveBeenCalled();
  });

  it.each(['review', 'confirm'] as const)(
    'rejects cross-origin %s before authentication or provider work',
    async (action) => {
      const response = await sandboxShareRoute(action)(
        request(action, undefined, { origin: 'https://untrusted.invalid' }),
        context(),
      );
      expect(response.status).toBe(403);
      expect(mocks.requireAccount).not.toHaveBeenCalled();
      expect(mocks.service).not.toHaveBeenCalled();
    },
  );

  it.each(['state', 'review', 'confirm'] as const)(
    'honors the disabled or unavailable sandbox service gate for %s',
    async (action) => {
      mocks.service.mockImplementation(() => {
        throw new AppError('SANDBOX_UNAVAILABLE', 'Test payments are unavailable.', 503);
      });
      const response = await sandboxShareRoute(action)(request(action), context());
      expect(response.status).toBe(503);
      expect(mocks.shareState).not.toHaveBeenCalled();
      expect(mocks.reviewShare).not.toHaveBeenCalled();
      expect(mocks.confirmShare).not.toHaveBeenCalled();
    },
  );

  it('rejects production app mode before any account or payment lookup', async () => {
    vi.stubEnv('APP_MODE', 'production');
    const response = await sandboxShareRoute('state')(request('state'), context());
    expect(response.status).toBe(503);
    expect(mocks.requireAccount).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('does not expose unknown provider or database error details', async () => {
    mocks.shareState.mockRejectedValue(new Error('private provider credential'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await sandboxShareRoute('state')(request('state'), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private provider credential');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
