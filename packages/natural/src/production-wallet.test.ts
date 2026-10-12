import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaturalProductionWalletClient, readProductionWalletConfig } from './production-wallet';
import { ProductionWalletTransport } from './transport';

const id = (prefix: string, n: string) => `${prefix}_${n.repeat(32)}`;
const platform = id('pty', '1');
const customer = id('pty', '2');
const config = {
  environment: 'production' as const,
  apiKey: 'ak_ntl_prod_wallet_fixture',
  agentId: id('agt', '3'),
  platformPartyId: platform,
};
function wallet(n = '4', agentDefault = true) {
  return {
    type: 'wallet',
    id: id('wal', n),
    attributes: {
      status: 'active',
      walletType: 'standard',
      isDefault: false,
      agentDefault,
      displayName: null,
      balance: { available: 0, total: 0, currency: 'USD' },
    },
    relationships: { party: { data: { type: 'party', id: customer } } },
  };
}
function fixtureClient(
  pages: ReturnType<typeof wallet>[][],
  mutate?: (value: ReturnType<typeof wallet>) => void,
) {
  let page = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/parties/me')
      return Response.json({
        data: { type: 'party', id: platform, attributes: { status: 'ACTIVE', partyType: 'ORG' } },
      });
    if (url.pathname.startsWith('/wallets/')) {
      const value = wallet();
      mutate?.(value);
      return Response.json({ data: value });
    }
    const value = pages[page++] ?? [];
    return Response.json({
      data: value,
      meta: {
        pagination: {
          hasMore: page < pages.length,
          nextCursor: page < pages.length ? `cursor_${page}` : null,
        },
      },
    });
  });
  return { client: new NaturalProductionWalletClient(config, { fetch: fetcher }), fetcher };
}

describe('production read-only granted wallet discovery', () => {
  it('requires independently named production agent credentials', () => {
    expect(() => readProductionWalletConfig({ NATURAL_AGENT_KEY: config.apiKey })).toThrow();
    expect(
      () => new NaturalProductionWalletClient({ ...config, apiKey: 'sk_ntl_prod_party' }),
    ).toThrow();
    expect(
      () => new NaturalProductionWalletClient({ ...config, apiKey: 'ak_ntl_sandbox_agent' }),
    ).toThrow();
    expect(
      readProductionWalletConfig({
        NATURAL_PRODUCTION_AGENT_KEY: config.apiKey,
        NATURAL_PRODUCTION_AGENT_ID: config.agentId,
        NATURAL_PRODUCTION_PLATFORM_PARTY_ID: platform,
      }),
    ).toEqual(config);
  });

  it('requires a complete inventory and verifies the granted default again with the agent key', async () => {
    const { client, fetcher } = fixtureClient([[wallet('5', false), wallet()]]);
    await expect(client.getReceivingWallet(customer)).resolves.toEqual({
      id: id('wal', '4'),
      partyId: customer,
      status: 'active',
      walletType: 'standard',
      isDefault: false,
      agentDefault: true,
      currency: 'USD',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://api.natural.com/wallets?customerPartyId=${customer}`,
    );
    expect(
      fetcher.mock.calls.every(
        ([url, request]) =>
          String(url).startsWith('https://api.natural.com/') && request?.method === 'GET',
      ),
    ).toBe(true);
    expect(fetcher.mock.calls[2]![1]?.headers).toMatchObject({
      Authorization: `Bearer ${config.apiKey}`,
    });
  });

  it('rejects the platform party before provider access', async () => {
    const { client, fetcher } = fixtureClient([[wallet()]]);
    await expect(client.getReceivingWallet(platform)).rejects.toMatchObject({
      reason: 'invalid_input',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { wallets: [] },
    { wallets: [wallet('4', false)] },
    { wallets: [wallet(), wallet('5')] },
    { wallets: [wallet(), wallet()] },
  ])('fails closed for absent, duplicate or ambiguous agent defaults', async ({ wallets }) => {
    await expect(
      fixtureClient([wallets]).client.getReceivingWallet(customer),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it('does not substitute the party default when the granted agent default is missing', async () => {
    const value = wallet('4', false);
    value.attributes.isDefault = true;
    await expect(
      fixtureClient([[value]]).client.getReceivingWallet(customer),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it.each([
    (value: ReturnType<typeof wallet>) => {
      value.relationships.party.data.id = platform;
    },
    (value: ReturnType<typeof wallet>) => {
      value.attributes.agentDefault = false;
    },
    (value: ReturnType<typeof wallet>) => {
      value.attributes.status = 'frozen';
    },
    (value: ReturnType<typeof wallet>) => {
      value.attributes.walletType = 'vault';
    },
    (value: ReturnType<typeof wallet>) => {
      value.id = id('wal', '9');
    },
  ])('rejects canonical detail changes after inventory selection', async (mutate) => {
    await expect(
      fixtureClient([[wallet()]], mutate).client.getReceivingWallet(customer),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it('rejects partial inventories even if they contain an agent default, without guessing pagination', async () => {
    const { client, fetcher } = fixtureClient([[wallet()], [wallet('5')]]);
    await expect(client.getReceivingWallet(customer)).rejects.toMatchObject({
      reason: 'invalid_response',
    });
    expect(fetcher).toHaveBeenCalledTimes(2); // party plus inventory, no final wallet detail
  });

  it('rejects arbitrary origin, unbound wallet and non-wallet read paths', () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new ProductionWalletTransport(config.apiKey, { fetch: fetcher });
    for (const path of [
      '/payments',
      '/wallets',
      '/wallets?customerPartyId=bad',
      'https://attacker.example/wallets',
      `/wallets?customerPartyId=${customer}&customerPartyId=${platform}`,
      `/wallets?customerPartyId=${customer}&cursor=undocumented`,
      `/wallets?customerPartyId=${customer}&limit=100`,
    ])
      expect(() => transport.request(path, z.unknown())).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
