import { describe, expect, it, vi } from 'vitest';
import { PhoneVault } from './phone-vault';
import { ChannelProviderError, SendblueVerify } from './sendblue';

const sid = `SV${'a'.repeat(32)}`;
const fixture = {
  sid: `VR${'b'.repeat(32)}`,
  service_sid: sid,
  to: '+12025550123',
  status: 'pending',
  expires_at: '2026-09-26T05:05:00.000Z',
  delivery_target: { pool_number: '+12025550124', code: 'ABC123', sms_deep_link: 'javascript:bad' },
};

describe('Sendblue adapter boundary', () => {
  it('authenticates only a fixed HTTPS origin, blocks redirects and drops provider-supplied links', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    const provider = new SendblueVerify({ keyId: 'test-id', secret: 'test-secret' }, transport);
    const result = await provider.create(sid, '+12025550123');
    expect(transport).toHaveBeenCalledWith(
      `https://api.sendblue.com/api/v2/verify/services/${sid}/verifications`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        body: '{"to":"+12025550123"}',
        headers: {
          'content-type': 'application/json',
          'sb-api-key-id': 'test-id',
          'sb-api-secret-key': 'test-secret',
        },
      }),
    );
    expect(result.delivery_target).toEqual({ pool_number: '+12025550124', code: 'ABC123' });
  });

  it('rejects malformed approved evidence and oversized bodies', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...fixture, status: 'approved', to: 'untrusted' }))
      .mockResolvedValueOnce(new Response('x'.repeat(33_000)));
    const provider = new SendblueVerify({ keyId: 'a', secret: 'b' }, transport);
    await expect(provider.retrieve(sid, fixture.sid)).rejects.toBeInstanceOf(ChannelProviderError);
    await expect(provider.retrieve(sid, fixture.sid)).rejects.toBeInstanceOf(ChannelProviderError);
  });

  it('preserves nullable terminal phone evidence for a fail-closed application decision', async () => {
    const provider = new SendblueVerify(
      { keyId: 'a', secret: 'b' },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...fixture, status: 'approved', to: null })),
    );
    expect((await provider.retrieve(sid, fixture.sid)).to).toBeNull();
  });

  it('does not surface response bodies or transport messages in errors', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('sensitive-provider-body', { status: 403 }))
      .mockRejectedValueOnce(new Error('sensitive-transport-message'));
    const provider = new SendblueVerify({ keyId: 'a', secret: 'b' }, transport);
    for (let i = 0; i < 2; i++)
      await expect(provider.create(sid, '+12025550123')).rejects.toThrow(
        'Phone verification is temporarily unavailable.',
      );
  });

  it('rejects path injection before calling the network', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      new SendblueVerify({ keyId: 'a', secret: 'b' }, transport).retrieve('../evil', fixture.sid),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('phone field encryption', () => {
  it('uses randomized authenticated ciphertext bound to the challenge field', () => {
    const vault = new PhoneVault('1'.repeat(64));
    const a = vault.seal('+12025550123', 'challenge:phone');
    const b = vault.seal('+12025550123', 'challenge:phone');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('202555');
    expect(vault.open(a, 'challenge:phone')).toEqual('+12025550123');
    expect(() => vault.open(a, 'another:phone')).toThrow();
    expect(() => new PhoneVault('2'.repeat(64)).open(a, 'challenge:phone')).toThrow();
  });

  it('derives stable keyed lookups and rejects missing key material', () => {
    const vault = new PhoneVault('1'.repeat(64));
    expect(vault.lookup('+12025550123')).toMatch(/^[a-f0-9]{64}$/);
    expect(vault.lookup('+12025550123')).not.toEqual(
      new PhoneVault('2'.repeat(64)).lookup('+12025550123'),
    );
    expect(() => new PhoneVault('')).toThrow();
  });
});
