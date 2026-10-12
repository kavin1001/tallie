import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';

const mocks = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  service: vi.fn(),
  connectionService: vi.fn(),
  state: vi.fn(),
  fund: vi.fn(),
  connectionState: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../identity', () => ({ requireAccount: mocks.requireAccount }));
vi.mock('./send-service', () => ({
  sandboxSendService: mocks.service,
  sandboxSendConnectionService: mocks.connectionService,
}));
import { sandboxSendRoute } from './send-http';

const origin = 'https://tallie.example';
const actor = { userId: 'account', sessionId: 'session', phoneHash: 'phone', displayName: 'Test' };
const state = {
  available: true,
  connection: { status: 'ready', retryAllowed: false, balances: [] },
  recipients: [],
  funding: null,
  transfers: [],
};
const request = (method: string, body = '{}', requestOrigin = origin) =>
  new Request(`${origin}/api/payments/sandbox/send`, {
    method,
    headers: { origin: requestOrigin, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body }),
  });

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'beta');
  vi.stubEnv('APP_ORIGIN', origin);
  vi.resetAllMocks();
  mocks.requireAccount.mockResolvedValue(actor);
  mocks.service.mockReturnValue({ state: mocks.state, fund: mocks.fund });
  mocks.connectionService.mockReturnValue({
    state: mocks.connectionState,
    start: mocks.start,
    retry: mocks.retry,
    refresh: mocks.refresh,
  });
  mocks.state.mockResolvedValue(state);
  mocks.connectionState.mockResolvedValue({
    connection: { status: 'connected', retryAllowed: false },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('sandbox send HTTP boundary', () => {
  it('reads current send state without entering or refreshing setup', async () => {
    const response = await sandboxSendRoute('state')(request('GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: state });
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.connectionService).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns current state after funding without refreshing the connection', async () => {
    const response = await sandboxSendRoute('fund')(
      request('POST', JSON.stringify({ amountMinor: '2500' })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: state });
    expect(mocks.fund).toHaveBeenCalledExactlyOnceWith(actor, '2500');
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.fund.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.state.mock.invocationCallOrder[0]!,
    );
    expect(mocks.connectionService).not.toHaveBeenCalled();
  });

  it('keeps connection refresh confined to an explicit setup command', async () => {
    const response = await sandboxSendRoute('setup')(request('POST'));
    expect(response.status).toBe(200);
    expect(mocks.connectionState).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it.each(['state', 'fund'] as const)(
    'authenticates %s before accessing services',
    async (action) => {
      mocks.requireAccount.mockRejectedValue(new AppError('AUTH_REQUIRED', 'Sign in.', 401));
      const response = await sandboxSendRoute(action)(
        request(action === 'state' ? 'GET' : 'POST', '{"amountMinor":"2500"}'),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.service).not.toHaveBeenCalled();
      expect(mocks.connectionService).not.toHaveBeenCalled();
    },
  );

  it('rejects cross-origin funding before authentication or any service command', async () => {
    const response = await sandboxSendRoute('fund')(
      request('POST', '{"amountMinor":"2500"}', 'https://untrusted.invalid'),
    );
    expect(response.status).toBe(403);
    expect(mocks.requireAccount).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.connectionService).not.toHaveBeenCalled();
  });

  it('rejects browser-supplied provider identities before funding', async () => {
    const response = await sandboxSendRoute('fund')(
      request('POST', '{"amountMinor":"2500","customerPartyId":"pty_untrusted"}'),
    );
    expect(response.status).toBe(400);
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.connectionService).not.toHaveBeenCalled();
  });
});
