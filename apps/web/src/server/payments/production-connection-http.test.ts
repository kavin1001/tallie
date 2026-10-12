import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionConnectionError } from '@tallie/payments';
import { AppError } from '../errors';
const mocks = vi.hoisted(() => ({
  requireAccount: vi.fn(),
  requireRecentAccount: vi.fn(),
  configuration: vi.fn(),
  service: vi.fn(),
  state: vi.fn(),
  start: vi.fn(),
  refresh: vi.fn(),
  matchReturn: vi.fn(),
}));
vi.mock('../identity', () => ({
  requireAccount: mocks.requireAccount,
  requireRecentAccount: mocks.requireRecentAccount,
}));
vi.mock('./production-connection', () => ({
  readProductionConnectionConfiguration: mocks.configuration,
  productionConnectionService: mocks.service,
}));
import { productionConnectionRoute } from './production-connection-http';
const origin = 'https://tallie.example';
const actor = { userId: 'account', sessionId: 'session', phoneHash: 'hash', displayName: 'Person' };
const state = {
  available: true,
  environment: 'production',
  moneyMovementEnabled: false,
  connection: null,
};
const token = 's'.repeat(43);
function request(
  action: 'state' | 'start' | 'return' | 'refresh',
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/payments/production/connect`, {
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
  mocks.requireRecentAccount.mockResolvedValue(actor);
  mocks.configuration.mockReturnValue({});
  mocks.service.mockReturnValue(mocks);
  mocks.state.mockResolvedValue(state);
  mocks.start.mockResolvedValue(state);
  mocks.refresh.mockResolvedValue(state);
  mocks.matchReturn.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe('production hosted account setup boundary', () => {
  it('reads only authenticated account state with private caching', async () => {
    const response = await productionConnectionRoute('state')(request('state'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('requires recent account assurance before starting the account-bound invitation', async () => {
    expect((await productionConnectionRoute('start')(request('start'))).status).toBe(200);
    expect(mocks.requireRecentAccount).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(actor);
  });
  it('rejects stale/phone-only authentication without opening the provider service', async () => {
    mocks.requireRecentAccount.mockRejectedValue(
      new AppError('STEP_UP_REQUIRED', 'Use your passkey.', 403),
    );
    expect((await productionConnectionRoute('start')(request('start'))).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('preserves the service stronger registered-passkey requirement', async () => {
    mocks.start.mockRejectedValue(new ProductionConnectionError('RECENT_PASSKEY_REQUIRED', 401));
    const response = await productionConnectionRoute('start')(request('start'));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('RECENT_PASSKEY_REQUIRED');
  });
  it('refreshes only the signed-in account without demanding another passkey ceremony', async () => {
    const connected = { ...state, connection: { status: 'connected', invitationUrl: null } };
    mocks.refresh.mockResolvedValue(connected);
    const response = await productionConnectionRoute('refresh')(request('refresh'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ data: connected });
    expect(mocks.requireAccount).toHaveBeenCalledTimes(1);
    expect(mocks.requireRecentAccount).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated refreshes before accessing the provider service', async () => {
    mocks.requireAccount.mockRejectedValue(new AppError('AUTH_REQUIRED', 'Sign in first.', 401));
    expect((await productionConnectionRoute('refresh')(request('refresh'))).status).toBe(401);
    expect(mocks.configuration).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('rejects client-provided identities and acceptance evidence on refresh', async () => {
    for (const body of [
      { accountId: 'another-account' },
      { customerPartyId: 'another-party' },
      { invitationId: 'adi_other' },
      { eventId: 'evt_forged' },
      { status: 'connected' },
      null,
      [],
    ])
      expect((await productionConnectionRoute('refresh')(request('refresh', body))).status).toBe(
        400,
      );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('rejects client-supplied phone, provider identity, limits, or redirect URLs', async () => {
    for (const body of [
      { phone: '+12025550101' },
      { agentId: 'agent' },
      { customerPartyId: 'party' },
      { perTransactionLimitMinor: 10000 },
      { redirectUrl: 'https://evil.example' },
    ])
      expect((await productionConnectionRoute('start')(request('start', body))).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('requires same-origin JSON for every setup mutation', async () => {
    for (const action of ['start', 'return', 'refresh'] as const)
      expect(
        (
          await productionConnectionRoute(action)(
            request(action, {}, { origin: 'https://evil.example' }),
          )
        ).status,
      ).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('returns explicit unavailable state when disabled without accessing production credentials', async () => {
    mocks.configuration.mockReturnValue(null);
    const response = await productionConnectionRoute('state')(request('state'));
    expect(await response.json()).toMatchObject({
      data: { available: false, moneyMovementEnabled: false, connection: null },
    });
    expect((await productionConnectionRoute('start')(request('start'))).status).toBe(503);
    expect((await productionConnectionRoute('refresh')(request('refresh'))).status).toBe(503);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('validates return navigation without creating an invitation or activating payments', async () => {
    const response = await productionConnectionRoute('return')(request('return', { state: token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { matched: true, moneyMovementEnabled: false } });
    expect(mocks.matchReturn).toHaveBeenCalledExactlyOnceWith(actor, token);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalled();
  });
  it('rejects mismatched and malformed return state', async () => {
    mocks.matchReturn.mockResolvedValue(false);
    expect(
      (await productionConnectionRoute('return')(request('return', { state: token }))).status,
    ).toBe(400);
    for (const body of [{ state: 'short' }, { state: token, accepted: true }, { eventId: 'fake' }])
      expect((await productionConnectionRoute('return')(request('return', body))).status).toBe(400);
    expect(mocks.matchReturn).toHaveBeenCalledTimes(1);
  });
});
