import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaturalOwnerPilotClient, readOwnerPilotConfig } from './owner-pilot';
import { OwnerPilotTransport } from './transport';

const id = (prefix: string, n: string) => `${prefix}_${n.repeat(32)}`;
const owner = id('pty', '1');
const recipient = id('pty', '2');
const config = {
  environment: 'production' as const,
  apiKey: 'ak_ntl_prod_owner_fixture',
  platformPartyId: owner,
  agentId: id('agt', '3'),
  walletId: id('wal', '4'),
};
const input = {
  walletId: config.walletId,
  recipientHandle: '@recipient',
  amountMinor: 100,
  operationId: 'owner_pilot_operation_01',
  idempotencyKey: 'owner_pilot_idempotency_01',
};
function party() {
  return {
    data: {
      type: 'party',
      id: owner,
      attributes: {
        partyType: 'PERSON',
        status: 'ACTIVE',
        handle: '@owner',
        primaryPhone: '+12025550101',
        firstName: 'Private',
        lastName: 'Fixture',
        email: 'private@example.test',
        addressLine1: 'Private address',
      },
    },
  };
}
function wallet() {
  return {
    data: {
      type: 'wallet',
      id: config.walletId,
      attributes: {
        status: 'active',
        walletType: 'standard',
        isDefault: true,
        displayName: null,
        balance: { available: 400, total: 400, currency: 'USD' },
        depositInstructions: { accountNumber: 'private-bank-fixture' },
      },
      relationships: { party: { data: { type: 'party', id: owner } } },
    },
  };
}
function payment(n = '5') {
  return {
    type: 'payment',
    id: id('pay', n),
    attributes: {
      amount: 100,
      currency: 'USD',
      status: 'COMPLETED',
      tags: {
        app_operation_id: input.operationId,
        tallie_owner_pilot: 'v1',
        recipient_handle: input.recipientHandle,
      },
      fee: null as { amount: number; currency: string; payer: string; applied: string } | null,
      claimLink: 'https://secret.example.test/claim',
    },
    relationships: {
      sender: { data: { type: 'party', id: owner } },
      senderAgent: { data: { type: 'agent', id: config.agentId } },
      recipient: { data: { type: 'party', id: recipient } as { type: string; id: string } | null },
      recipientAgent: { data: null as { type: string; id: string } | null },
      paymentRequest: { data: null as { type: string; id: string } | null },
    },
  };
}
function page(payments: ReturnType<typeof payment>[], cursor: string | null = null) {
  return { data: payments, meta: { pagination: { hasMore: cursor !== null, nextCursor: cursor } } };
}
type Fixtures = {
  party?: ReturnType<typeof party>;
  wallet?: ReturnType<typeof wallet>;
  payment?: ReturnType<typeof payment>;
  pages?: ReturnType<typeof page>[];
  mutation?: () => Promise<Response>;
};
function fixture(values: Fixtures = {}) {
  let index = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/parties/me') return Response.json(values.party ?? party());
    if (url.pathname.startsWith('/wallets/')) return Response.json(values.wallet ?? wallet());
    if (init?.method === 'POST' && values.mutation) return values.mutation();
    if (url.pathname === '/payments' && init?.method === 'GET')
      return Response.json(values.pages?.[index++] ?? page([]));
    return Response.json({ data: values.payment ?? payment() });
  });
  return { client: new NaturalOwnerPilotClient(config, { fetch: fetcher }), fetcher };
}

describe('isolated production owner payment pilot', () => {
  it('requires explicit production agent, owner and wallet configuration', () => {
    expect(
      readOwnerPilotConfig({
        NATURAL_PRODUCTION_AGENT_KEY: config.apiKey,
        NATURAL_PRODUCTION_AGENT_ID: config.agentId,
        NATURAL_PRODUCTION_PLATFORM_PARTY_ID: owner,
        NATURAL_OWNER_PILOT_WALLET_ID: config.walletId,
      }),
    ).toEqual(config);
    expect(() => readOwnerPilotConfig({ NATURAL_AGENT_KEY: config.apiKey })).toThrow();
    for (const apiKey of ['sk_ntl_prod_fixture', 'ak_ntl_sandbox_fixture', ''])
      expect(() => new NaturalOwnerPilotClient({ ...config, apiKey })).toThrow();
    expect(() => new NaturalOwnerPilotClient({ ...config, walletId: '' })).toThrow();
  });

  it('returns only the owner identity and canonical available balance', async () => {
    const { client, fetcher } = fixture();
    await expect(client.getOwnerWallet()).resolves.toEqual({
      partyId: owner,
      partyType: 'PERSON',
      status: 'ACTIVE',
      handle: '@owner',
      primaryPhone: '+12025550101',
      walletId: config.walletId,
      availableMinor: 400,
      currency: 'USD',
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.natural.com/parties/me',
      `https://api.natural.com/wallets/${config.walletId}`,
    ]);
    for (const [, request] of fetcher.mock.calls) {
      expect(request?.method).toBe('GET');
      expect(request?.headers).toEqual({
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      });
    }
  });

  it.each([
    (v: ReturnType<typeof party>) => {
      v.data.id = recipient;
    },
    (v: ReturnType<typeof party>) => {
      v.data.attributes.partyType = 'ORG';
    },
    (v: ReturnType<typeof party>) => {
      v.data.attributes.status = 'SUSPENDED';
    },
  ])('rejects an unrelated or unavailable owner before reading the wallet', async (mutate) => {
    const value = party();
    mutate(value);
    const { client, fetcher } = fixture({ party: value });
    await expect(client.send(input)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'not_submitted',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    (v: ReturnType<typeof wallet>) => {
      v.data.id = id('wal', '9');
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.relationships.party.data.id = recipient;
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.attributes.status = 'frozen';
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.attributes.walletType = 'vault';
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.attributes.balance.currency = 'EUR';
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.attributes.balance.available = 99;
    },
    (v: ReturnType<typeof wallet>) => {
      v.data.attributes.balance.available = Number.MAX_SAFE_INTEGER + 1;
    },
  ])('does not submit from an invalid or insufficient source wallet', async (mutate) => {
    const value = wallet();
    mutate(value);
    const { client, fetcher } = fixture({ wallet: value });
    await expect(client.send(input)).rejects.toMatchObject({ outcome: 'not_submitted' });
    expect(fetcher.mock.calls.every(([, request]) => request?.method === 'GET')).toBe(true);
  });

  it('rejects a null balance instead of treating it as zero or unlimited', async () => {
    const value = wallet();
    Object.assign(value.data.attributes, { balance: null });
    await expect(fixture({ wallet: value }).client.getOwnerWallet()).rejects.toMatchObject({
      reason: 'binding_mismatch',
    });
  });

  it('sends the exact approved dollar, wallet, handle and stable operation without customer context', async () => {
    const { client, fetcher } = fixture();
    const result = await client.send(input);
    expect(result).toEqual({
      id: id('pay', '5'),
      status: 'COMPLETED',
      amountMinor: 100,
      currency: 'USD',
      senderPartyId: owner,
      senderAgentId: config.agentId,
      recipientPartyId: recipient,
      recipientAgentId: null,
      tags: payment().attributes.tags,
      feeMinor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, request] = fetcher.mock.calls[2]!;
    expect(String(url)).toBe('https://api.natural.com/payments');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(request?.headers).toEqual({
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
      'X-Instance-ID': input.operationId,
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      data: {
        attributes: {
          walletId: config.walletId,
          amount: 100,
          currency: 'USD',
          counterparty: { type: 'handle', value: input.recipientHandle },
          description: 'Tallie personal payment test',
          tags: payment().attributes.tags,
        },
      },
    });
  });

  it.each([
    { amountMinor: 0 },
    { amountMinor: 101 },
    { amountMinor: 1.5 },
    { amountMinor: '100' },
    { recipientHandle: 'recipient' },
    { recipientHandle: '@bad name' },
    { recipientHandle: '@' },
    { recipientHandle: '@' + 'a'.repeat(62) },
    { walletId: id('wal', '9') },
    { customerPartyId: recipient },
    { operationId: 'line\nbreak' },
    { idempotencyKey: 'bad\r\nheader' },
  ])('rejects unapproved input before any provider request: %j', async (patch) => {
    const { client, fetcher } = fixture();
    await expect(client.send({ ...input, ...patch } as typeof input)).rejects.toMatchObject({
      outcome: 'not_submitted',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not send to the owner handle regardless of case', async () => {
    const { client, fetcher } = fixture();
    await expect(client.send({ ...input, recipientHandle: '@OwNeR' })).rejects.toMatchObject({
      reason: 'binding_mismatch',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    (v: ReturnType<typeof payment>) => {
      v.attributes.amount = 99;
    },
    (v: ReturnType<typeof payment>) => {
      v.relationships.sender.data.id = recipient;
    },
    (v: ReturnType<typeof payment>) => {
      v.relationships.senderAgent.data.id = id('agt', '9');
    },
    (v: ReturnType<typeof payment>) => {
      v.relationships.recipient.data!.id = owner;
    },
    (v: ReturnType<typeof payment>) => {
      v.relationships.paymentRequest.data = { type: 'paymentRequest', id: id('prq', '9') };
    },
    (v: ReturnType<typeof payment>) => {
      v.attributes.tags.app_operation_id = 'other_operation';
    },
    (v: ReturnType<typeof payment>) => {
      v.attributes.tags.recipient_handle = '@changed';
    },
    (v: ReturnType<typeof payment>) => {
      v.attributes.tags.tallie_owner_pilot = 'v2';
    },
  ])('preserves uncertainty after a response binding mismatch', async (mutate) => {
    const value = payment();
    mutate(value);
    const { client, fetcher } = fixture({ payment: value });
    await expect(client.send(input)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'unknown',
    });
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(1);
  });

  it('preserves nullable recipient and returned fee without assuming settlement', async () => {
    const value = payment();
    value.attributes.status = 'PENDING_CLAIM';
    value.relationships.recipient.data = null;
    value.relationships.recipientAgent.data = { type: 'agent', id: id('agt', '9') };
    value.attributes.fee = { amount: 1, currency: 'USD', payer: 'sender', applied: 'on_top' };
    await expect(fixture({ payment: value }).client.send(input)).resolves.toMatchObject({
      status: 'PENDING_CLAIM',
      recipientPartyId: null,
      recipientAgentId: id('agt', '9'),
      feeMinor: 1,
    });
  });

  it.each([400, 403, 409, 429, 500])(
    'never retries a provider HTTP %i response',
    async (status) => {
      const { client, fetcher } = fixture({
        mutation: async () => new Response('private-upstream-error', { status }),
      });
      await expect(client.send(input)).rejects.toMatchObject({
        reason: 'http',
        outcome: [400, 403].includes(status) ? 'rejected' : 'unknown',
        status,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    async () => {
      throw new Error('private transport failure');
    },
    async () => Response.json({ malformed: true }),
    async () =>
      new Response('private-upstream-error', { headers: { 'content-type': 'text/html' } }),
  ])('does not retry an unknown submission result or leak upstream details', async (mutation) => {
    const { client, fetcher } = fixture({ mutation });
    await expect(client.send(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reads only the exact canonical payment and rejects a changed payment ID', async () => {
    const { client, fetcher } = fixture();
    await expect(client.getPayment(id('pay', '5'))).resolves.toMatchObject({ id: id('pay', '5') });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `https://api.natural.com/payments/${id('pay', '5')}`,
    );
    await expect(client.getPayment(id('pay', '6'))).rejects.toMatchObject({
      reason: 'binding_mismatch',
    });
  });

  it('scans a complete inventory with safely encoded cursors before returning a match', async () => {
    const unrelated = payment('6');
    unrelated.attributes.tags.app_operation_id = 'another_operation';
    const { client, fetcher } = fixture({
      pages: [page([payment()], 'opaque/+?='), page([unrelated])],
    });
    await expect(client.findPayment(input.operationId)).resolves.toMatchObject({
      id: id('pay', '5'),
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.natural.com/payments?limit=100',
      'https://api.natural.com/payments?limit=100&cursor=opaque%2F%2B%3F%3D',
    ]);
    await expect(
      fixture({ pages: [page([])] }).client.findPayment(input.operationId),
    ).resolves.toBeNull();
  });

  it.each([
    [page([payment(), payment('6')])],
    [page([payment()], 'next'), page([payment('6')])],
    [page([payment()], 'next'), page([payment()])],
    [page([], 'same'), page([], 'same')],
    Array.from({ length: 10 }, (_, i) => page(i === 0 ? [payment()] : [], `cursor_${i}`)),
    Array.from({ length: 10 }, (_, i) => page([], `cursor_${i}`)),
  ])('never treats ambiguous or incomplete history as a definitive result', async (...pages) => {
    const { client, fetcher } = fixture({ pages });
    await expect(client.findPayment(input.operationId)).rejects.toMatchObject({
      reason: 'invalid_response',
      outcome: 'not_submitted',
    });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('rejects another sender in the supposedly owner-scoped payment list', async () => {
    const value = payment();
    value.relationships.sender.data.id = recipient;
    await expect(
      fixture({ pages: [page([value])] }).client.findPayment(input.operationId),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
  });

  it('blocks all other transport paths, customer queries and unsafe command attributes', () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new OwnerPilotTransport(config.apiKey, config.walletId, { fetch: fetcher });
    for (const path of [
      '/payments',
      '/wallets',
      `/wallets/${id('wal', '9')}`,
      '/agents/' + config.agentId,
      '/agent-keys',
      '/simulations/payments',
      `/wallets/${config.walletId}/deposit`,
      `/wallets/${config.walletId}/withdraw`,
      `/payments/${id('pay', '5')}/cancel`,
      `/payments/${id('pay', '5')}?customerPartyId=${owner}`,
      `/parties/me?customerPartyId=${owner}`,
      '/payments?limit=100&customerPartyId=' + owner,
      '/payments?limit=99',
      '/payments?limit=100&limit=100',
      '/payments?limit=100&cursor=',
      '/payments?limit=100#fragment',
      'https://api.natural.com/payments?limit=100',
      'https://attacker.example/payments?limit=100',
    ])
      expect(() => transport.request(path, z.unknown())).toThrow();
    const attributes = {
      walletId: config.walletId,
      amount: 100,
      currency: 'USD',
      counterparty: { type: 'handle', value: input.recipientHandle },
      description: 'Tallie personal payment test',
      tags: payment().attributes.tags,
    };
    const operation = { instanceId: input.operationId, idempotencyKey: input.idempotencyKey };
    for (const patch of [
      { customerPartyId: owner },
      { context: { customerPartyId: owner } },
      { amount: 101 },
      { walletId: id('wal', '9') },
      { description: 'other' },
      { counterparty: { type: 'party_id', value: recipient } },
      { tags: { ...attributes.tags, extra: 'forbidden' } },
      { tags: { ...attributes.tags, app_operation_id: 'different_operation' } },
      { tags: { ...attributes.tags, recipient_handle: '@different' } },
    ])
      expect(() =>
        transport.request('/payments', z.unknown(), {
          operation,
          attributes: { ...attributes, ...patch },
        }),
      ).toThrow();
    for (const path of [
      '/payments?limit=100',
      '/parties/me',
      '/simulations/payments',
      `/wallets/${config.walletId}/deposit`,
    ])
      expect(() => transport.request(path, z.unknown(), { operation, attributes })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
