import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCookieGetter, getCookies } from 'better-auth/cookies';
import { browserTokenFromHeaders, createIdentityAuth, SIGNUP_COOKIE } from './auth';
import { cookieNames } from './config';

// Capture our auth options without starting Better Auth's database introspection.
// Cookie construction still uses the installed Better Auth implementation.
vi.mock('better-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth')>()),
  betterAuth: (options: unknown) => ({ options }),
}));

const pilotOrigin = 'http://localhost:3004';
const otherOrigin = 'http://localhost:3001';
const pilotToken = 'p'.repeat(43);
const otherToken = 'o'.repeat(43);
const bothCookies = new Headers({
  cookie: `tallie_signup=${otherToken}; tallie_owner_pilot_signup=${pilotToken}`,
});

function authAt(origin: string) {
  type Config = Parameters<typeof createIdentityAuth>[0];
  return createIdentityAuth({
    origin,
    secret: 'synthetic-identity-cookie-test-secret-123456',
    db: {} as Config['db'],
    signup: {} as Config['signup'],
  });
}

describe('identity cookie namespace isolation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reserves a namespace for the fixed owner pilot origin', () => {
    expect(cookieNames(pilotOrigin)).toEqual({
      signup: 'tallie_owner_pilot_signup',
      prefix: 'tallie_owner_pilot_identity',
      passkeyChallenge: 'tallie_owner_pilot_identity.passkey_challenge',
    });
  });

  it.each([
    undefined,
    otherOrigin,
    'http://localhost:3000',
    'http://127.0.0.1:3004',
    'https://localhost:3004',
    'https://tallie.example',
  ])('preserves all existing cookie names for %s', (origin) => {
    expect(cookieNames(origin)).toEqual({
      signup: SIGNUP_COOKIE,
      prefix: 'tallie_identity',
      passkeyChallenge: 'tallie_identity.passkey_challenge',
    });
    expect(SIGNUP_COOKIE).toBe('tallie_signup');
  });

  it('selects only the configured signup token from a shared localhost cookie jar', () => {
    expect(browserTokenFromHeaders(bothCookies, pilotOrigin)).toBe(pilotToken);
    expect(browserTokenFromHeaders(bothCookies, otherOrigin)).toBe(otherToken);
    expect(
      browserTokenFromHeaders(new Headers({ cookie: `tallie_signup=${otherToken}` }), pilotOrigin),
    ).toBeNull();
    expect(
      browserTokenFromHeaders(
        new Headers({ cookie: `tallie_owner_pilot_signup=${pilotToken}` }),
        otherOrigin,
      ),
    ).toBeNull();
  });

  it('reads the current default origin on each call and honors an explicit auth origin', () => {
    vi.stubEnv('APP_ORIGIN', otherOrigin);
    expect(browserTokenFromHeaders(bothCookies)).toBe(otherToken);
    expect(browserTokenFromHeaders(bothCookies, pilotOrigin)).toBe(pilotToken);
    vi.stubEnv('APP_ORIGIN', pilotOrigin);
    expect(browserTokenFromHeaders(bothCookies)).toBe(pilotToken);
    expect(browserTokenFromHeaders(bothCookies, otherOrigin)).toBe(otherToken);
  });

  it('rejects malformed and similarly named pilot signup cookies', () => {
    for (const cookie of [
      'tallie_owner_pilot_signup=short',
      `tallie_owner_pilot_signup=${'p'.repeat(44)}`,
      `tallie_owner_pilot_signup=${'p'.repeat(42)}!`,
      `other_tallie_owner_pilot_signup=${pilotToken}`,
    ]) {
      expect(browserTokenFromHeaders(new Headers({ cookie }), pilotOrigin)).toBeNull();
    }
  });

  it('isolates every Better Auth cookie using the supplied origin even when APP_ORIGIN differs', () => {
    vi.stubEnv('APP_ORIGIN', otherOrigin);
    const pilot = authAt(pilotOrigin);
    vi.stubEnv('APP_ORIGIN', pilotOrigin);
    const other = authAt(otherOrigin);
    expect(pilot.options.advanced.cookiePrefix).toBe('tallie_owner_pilot_identity');
    expect(other.options.advanced.cookiePrefix).toBe('tallie_identity');
    const pilotCookies = getCookies(pilot.options);
    const otherCookies = getCookies(other.options);
    expect(pilotCookies.sessionToken.name).toBe('tallie_owner_pilot_identity.session_token');
    expect(otherCookies.sessionToken.name).toBe('tallie_identity.session_token');
    const otherNames = new Set(Object.values(otherCookies).map((cookie) => cookie.name));
    for (const cookie of Object.values(pilotCookies)) {
      expect(otherNames.has(cookie.name)).toBe(false);
      expect(cookie.attributes).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
      });
    }
    expect(pilot.options.plugins.find((plugin) => plugin.id === 'passkey')).toMatchObject({
      options: {
        advanced: { webAuthnChallengeCookie: 'tallie_owner_pilot_identity.passkey_challenge' },
      },
    });
    expect(other.options.plugins.find((plugin) => plugin.id === 'passkey')).toMatchObject({
      options: { advanced: { webAuthnChallengeCookie: 'tallie_identity.passkey_challenge' } },
    });
    expect(
      createCookieGetter(pilot.options)('tallie_owner_pilot_identity.passkey_challenge').name,
    ).toBe('tallie_owner_pilot_identity.tallie_owner_pilot_identity.passkey_challenge');
    expect(createCookieGetter(other.options)('tallie_identity.passkey_challenge').name).toBe(
      'tallie_identity.tallie_identity.passkey_challenge',
    );
  });

  it('preserves secure hosted cookies and their existing namespace', () => {
    const auth = authAt('https://tallie.example');
    const cookies = getCookies(auth.options);
    expect(cookies.sessionToken.name).toBe('__Secure-tallie_identity.session_token');
    expect(cookies.sessionToken.attributes.secure).toBe(true);
    expect(createCookieGetter(auth.options)('tallie_identity.passkey_challenge').name).toBe(
      '__Secure-tallie_identity.tallie_identity.passkey_challenge',
    );
  });
});
