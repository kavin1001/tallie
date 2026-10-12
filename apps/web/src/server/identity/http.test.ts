import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireBrowser, signupBrowser } from './http';

const pilotOrigin = 'http://localhost:3004';
const otherOrigin = 'http://localhost:3001';
const pilotToken = 'p'.repeat(43);
const otherToken = 'o'.repeat(43);
function request(cookie: string, origin = pilotOrigin) {
  return new Request(`${origin}/api/identity/signup`, { headers: { cookie } });
}

describe('signup browser cookies across localhost apps', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('starts an independent pilot signup without replacing the existing app cookie', () => {
    vi.stubEnv('APP_ORIGIN', pilotOrigin);
    const result = signupBrowser(request(`tallie_signup=${otherToken}`));
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.token).not.toBe(otherToken);
    expect(result.headers.get('set-cookie')).toBe(
      `tallie_owner_pilot_signup=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`,
    );
    expect(() => requireBrowser(request(`tallie_signup=${otherToken}`))).toThrow(
      'Start verification from this browser.',
    );
  });

  it('reuses only the pilot token when both localhost apps have signup cookies', () => {
    vi.stubEnv('APP_ORIGIN', pilotOrigin);
    const input = request(`tallie_signup=${otherToken}; tallie_owner_pilot_signup=${pilotToken}`);
    expect(signupBrowser(input).token).toBe(pilotToken);
    expect(signupBrowser(input).headers.has('set-cookie')).toBe(false);
    expect(requireBrowser(input)).toBe(pilotToken);
  });

  it('keeps the existing app independent and uses server configuration for cookie selection', () => {
    vi.stubEnv('APP_ORIGIN', otherOrigin);
    // The request URL does not select a cookie namespace.
    const input = request(`tallie_owner_pilot_signup=${pilotToken}`);
    const result = signupBrowser(input);
    expect(result.token).not.toBe(pilotToken);
    expect(result.headers.get('set-cookie')).toBe(
      `tallie_signup=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`,
    );
    expect(() => requireBrowser(input)).toThrow('Start verification from this browser.');
    const both = request(`tallie_signup=${otherToken}; tallie_owner_pilot_signup=${pilotToken}`);
    expect(signupBrowser(both).token).toBe(otherToken);
    expect(signupBrowser(both).headers.has('set-cookie')).toBe(false);
    expect(requireBrowser(both)).toBe(otherToken);
  });

  it('uses current configuration and retains secure attributes for HTTPS', () => {
    vi.stubEnv('APP_ORIGIN', pilotOrigin);
    expect(signupBrowser(request('')).headers.get('set-cookie')).toMatch(
      /^tallie_owner_pilot_signup=/,
    );
    vi.stubEnv('APP_ORIGIN', 'https://tallie.example');
    const result = signupBrowser(request(''));
    expect(result.headers.get('set-cookie')).toBe(
      `tallie_signup=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure`,
    );
  });
});
