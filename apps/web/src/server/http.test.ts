import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertMutationOrigin, idempotencyKey, readJson, route } from './http';
import { cents, createExpenseSchema, emptySchema } from './validation';
import { sessionCookie } from './session';

afterEach(() => vi.unstubAllEnvs());

describe('HTTP security boundary', () => {
  it('requires exact configured Origin and rejects cross-site mutations', () => {
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    const request = (headers: Record<string, string>) =>
      new Request('http://localhost:3000/api/demo/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
    expect(() => assertMutationOrigin(request({ origin: 'http://localhost:3000' }))).not.toThrow();
    expect(() => assertMutationOrigin(request({ origin: 'https://evil.example' }))).toThrow();
    expect(() => assertMutationOrigin(request({}))).toThrow();
    expect(() =>
      assertMutationOrigin(
        request({ origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }),
      ),
    ).toThrow();
  });

  it('limits actual body bytes even when content-length is omitted', async () => {
    const request = new Request('http://localhost:3000', {
      method: 'POST',
      body: JSON.stringify({ value: 'a'.repeat(70_000) }),
    });
    await expect(readJson(request, emptySchema)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects noncanonical money transport and injected unknown fields', () => {
    for (const value of ['1\n', '01', '-1', '1.00', ' 100', '10000001'])
      expect(cents.safeParse(value).success).toBe(false);
    expect(cents.safeParse('100').success).toBe(true);
    expect(createExpenseSchema.safeParse({ payerId: 'injected' }).success).toBe(false);
  });

  it('uses opaque HttpOnly strict cookies, never browser-readable bearer storage', () => {
    vi.stubEnv('APP_ORIGIN', 'https://tallie.example');
    expect(sessionCookie('test')).toContain('HttpOnly; SameSite=Strict');
    expect(sessionCookie('test')).toContain('; Secure');
    expect(sessionCookie('test')).not.toContain('Domain=');
  });

  it('requires a retry key for commands', () => {
    expect(() => idempotencyKey(new Request('http://localhost:3000'))).toThrow();
    expect(
      idempotencyKey(
        new Request('http://localhost:3000', { headers: { 'idempotency-key': 'abcdefgh-1234' } }),
      ),
    ).toBe('abcdefgh-1234');
  });

  it('fails closed outside demo and never exposes internals in API errors', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const handler = vi.fn(async () => Response.json({ secret: 'provider-internal' }));
    const response = await route(handler)(new Request('http://localhost:3000/api/dashboard'));
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).error.code).toBe('LIVE_INTEGRATIONS_UNAVAILABLE');
  });
});
