import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaturalProductionBankClient, readProductionBankConfig } from './production-bank';
import { ProductionBankTransport } from './transport';

const id = (prefix: string, n: string) => `${prefix}_${n.repeat(32)}`;
const platform = id('pty', '1');
const customer = id('pty', '2');
const config = {
  environment: 'production' as const,
  apiKey: 'ak_ntl_prod_bank_fixture',
  agentId: id('agt', '3'),
  platformPartyId: platform,
};
function bank(n = '4') {
  return {
    type: 'externalAccount',
    id: id('eac', n),
    attributes: {
      lastFour: '6789',
      bankName: 'Example Bank',
      accountType: 'checking',
      status: 'active',
      connectionStatus: 'active',
      availableMethods: ['standard', 'instant'],
      createdAt: '2026-09-26T00:00:00Z',
      accountName: 'Private user-defined label',
      tags: { private: 'not for the browser' },
      accountNumber: '123456789',
      routingNumber: '999999999',
    },
    relationships: { party: { data: { type: 'party', id: customer } } },
  };
}
const expectedBank = {
  id: id('eac', '4'),
  lastFour: '6789',
  bankName: 'Example Bank',
  accountType: 'checking',
  readiness: 'connected',
  withdrawalMethods: ['standard', 'instant'],
};
function page(banks = [bank()], hasMore = false, nextCursor: string | null = null) {
  return { data: banks, meta: { pagination: { hasMore, nextCursor } } };
}
function fixture(value: unknown = page(), options?: { partyId?: string; status?: string }) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/parties/me')
      return Response.json({
        data: {
          type: 'party',
          id: options?.partyId ?? platform,
          attributes: { status: options?.status ?? 'ACTIVE', partyType: 'ORG' },
        },
      });
    return Response.json(value);
  });
  return { client: new NaturalProductionBankClient(config, { fetch: fetcher }), fetcher };
}

describe('production read-only customer bank discovery', () => {
  it('requires separately named production agent credentials', () => {
    expect(() => readProductionBankConfig({ NATURAL_AGENT_KEY: config.apiKey })).toThrow();
    for (const apiKey of ['sk_ntl_prod_party', 'ak_ntl_sandbox_agent', ''])
      expect(() => new NaturalProductionBankClient({ ...config, apiKey })).toThrow();
    expect(
      readProductionBankConfig({
        NATURAL_PRODUCTION_AGENT_KEY: config.apiKey,
        NATURAL_PRODUCTION_AGENT_ID: config.agentId,
        NATURAL_PRODUCTION_PLATFORM_PARTY_ID: platform,
      }),
    ).toEqual(config);
  });

  it('only returns masked display metadata and makes customer-scoped GETs', async () => {
    const { client, fetcher } = fixture();
    await expect(client.listLinkedBanks({ customerPartyId: customer })).resolves.toEqual({
      banks: [expectedBank],
      hasMore: false,
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://api.natural.com/external-accounts?customerPartyId=${customer}&limit=20`,
    );
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.natural\.com\//);
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      expect(init?.body).toBeUndefined();
    }
  });

  it('encodes opaque cursors and preserves partial inventory metadata', async () => {
    const cursor = 'opaque+cursor&customerPartyId=other';
    const { client, fetcher } = fixture(page([], true, 'next_page'));
    await expect(
      client.listLinkedBanks({ customerPartyId: customer, cursor, limit: 1 }),
    ).resolves.toEqual({ banks: [], hasMore: true, nextCursor: 'next_page' });
    const url = new URL(String(fetcher.mock.calls[1]![0]));
    expect(url.searchParams.getAll('customerPartyId')).toEqual([customer]);
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it.each([
    { customerPartyId: platform },
    { customerPartyId: 'invalid' },
    { customerPartyId: customer, cursor: '' },
    { customerPartyId: customer, cursor: 'x'.repeat(1025) },
    { customerPartyId: customer, limit: 0 },
    { customerPartyId: customer, limit: 101 },
    { customerPartyId: customer, limit: 1.5 },
    { customerPartyId: customer, unexpected: true },
  ])('rejects malformed or platform customer input before provider access', async (input) => {
    const { client, fetcher } = fixture();
    await expect(client.listLinkedBanks(input)).rejects.toMatchObject({ reason: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ partyId: customer }, { status: 'SUSPENDED' }])(
    'rejects mismatched or inactive credential owners before bank reads',
    async (options) => {
      const { client, fetcher } = fixture(page(), options);
      await expect(client.listLinkedBanks({ customerPartyId: customer })).rejects.toMatchObject({
        reason: 'binding_mismatch',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an inventory containing any other customer or duplicate account', async () => {
    const foreign = bank('5');
    foreign.relationships.party.data.id = platform;
    for (const response of [page([bank(), foreign]), page([bank(), bank()])])
      await expect(
        fixture(response).client.listLinkedBanks({ customerPartyId: customer }),
      ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it.each([
    page([bank()], true, null),
    page([bank()], false, 'unexpected_cursor'),
    page([bank()], true, 'previous_cursor'),
    page([bank(), bank('5')]),
  ])('rejects inconsistent, looping or over-limit pagination', async (response) => {
    await expect(
      fixture(response).client.listLinkedBanks({
        customerPartyId: customer,
        cursor: 'previous_cursor',
        limit: 1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it.each([
    { status: 'active', connectionStatus: 'active', readiness: 'connected' },
    { status: 'active', connectionStatus: 'login_required', readiness: 'relink_required' },
    { status: 'active', connectionStatus: 'disconnected', readiness: 'relink_required' },
    { status: 'pending', connectionStatus: 'active', readiness: 'pending' },
    { status: 'new', connectionStatus: 'active', readiness: 'pending' },
    { status: 'disabled', connectionStatus: 'active', readiness: 'unavailable' },
    { status: 'deleted', connectionStatus: 'active', readiness: 'unavailable' },
    { status: 'unknown', connectionStatus: 'active', readiness: 'unavailable' },
  ])('keeps $status / $connectionStatus distinct from authorization', async (state) => {
    const value = bank();
    Object.assign(value.attributes, state);
    const { client } = fixture(page([value]));
    const result = await client.listLinkedBanks({ customerPartyId: customer });
    expect(result.banks[0]).toEqual({
      ...expectedBank,
      readiness: state.readiness,
      withdrawalMethods: state.readiness === 'connected' ? ['standard', 'instant'] : [],
    });
    expect(result.banks[0]).not.toHaveProperty('verified');
    expect(result.banks[0]).not.toHaveProperty('canPay');
  });

  it.each([
    { lastFour: '123456789' },
    { lastFour: '123' },
    { status: 'future_status' },
    { connectionStatus: 'unknown' },
    { availableMethods: ['future_method'] },
    { bankName: 'x'.repeat(161) },
  ])('rejects unsafe or unknown provider metadata', async (attributes) => {
    const value = bank();
    Object.assign(value.attributes, attributes);
    await expect(
      fixture(page([value])).client.listLinkedBanks({ customerPartyId: customer }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('rereads the selected account and does not reuse old connection readiness', async () => {
    const value = bank();
    value.attributes.connectionStatus = 'login_required';
    const { client, fetcher } = fixture({ data: value });
    await expect(
      client.getLinkedBank({ customerPartyId: customer, externalAccountId: value.id }),
    ).resolves.toEqual({ ...expectedBank, readiness: 'relink_required', withdrawalMethods: [] });
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://api.natural.com/external-accounts/${value.id}?customerPartyId=${customer}`,
    );
  });

  it.each(['account', 'customer'])('rejects a canonical %s mismatch', async (mismatch) => {
    const value = bank();
    if (mismatch === 'account') value.id = id('eac', '5');
    else value.relationships.party.data.id = platform;
    await expect(
      fixture({ data: value }).client.getLinkedBank({
        customerPartyId: customer,
        externalAccountId: id('eac', '4'),
      }),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it('does not retry a revoked grant or expose provider response details', async () => {
    const { client, fetcher } = fixture();
    fetcher.mockImplementationOnce(async () =>
      Response.json({ errors: [{ detail: 'private provider context' }] }, { status: 403 }),
    );
    await expect(client.listLinkedBanks({ customerPartyId: customer })).rejects.toMatchObject({
      reason: 'http',
      outcome: 'not_submitted',
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('restricts transport paths to explicit customer-bound bank GETs', () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new ProductionBankTransport(config.apiKey, { fetch: fetcher });
    for (const path of [
      '/external-accounts',
      `/external-accounts?customerPartyId=${customer}&customerPartyId=${platform}`,
      `/external-accounts?customerPartyId=${customer}&limit=101`,
      `/external-accounts?customerPartyId=${customer}&limit=0`,
      `/external-accounts?customerPartyId=${customer}&cursor=`,
      `/external-accounts?customerPartyId=${customer}&method=POST`,
      `/external-accounts?customerPartyId=${customer}#fragment`,
      `/external-accounts/${id('eac', '4')}?customerPartyId=${customer}&cursor=page`,
      `/external-accounts/${id('eac', '4')}/delete?customerPartyId=${customer}`,
      `/external-accounts?customerPartyId=invalid`,
      `/transfers/deposit?customerPartyId=${customer}`,
      `/payments?customerPartyId=${customer}`,
      `/simulations/external-accounts?customerPartyId=${customer}`,
      `https://attacker.example/external-accounts?customerPartyId=${customer}`,
      `https://api.natural.com/external-accounts?customerPartyId=${customer}`,
    ])
      expect(() => transport.request(path, z.unknown())).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
