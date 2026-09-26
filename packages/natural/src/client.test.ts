import { describe, expect, it, vi } from 'vitest';
import {
  NaturalAgentClient,
  NaturalProvisioningClient,
  NaturalProviderError,
  readAgentConfig,
  readProvisioningConfig,
  NATURAL_SANDBOX_ORIGIN,
  type NaturalRequestBinding,
} from './index';

const id = (prefix: string, digit: string) => `${prefix}_${digit.repeat(32)}`;
const platform = id('pty', '0');
const requester = id('pty', '1');
const payer = id('pty', '2');
const agentId = id('agt', '3');
const walletId = id('wal', '4');
const payerWalletId = id('wal', '5');
const externalAccountId = id('eac', '6');
const requestId = id('prq', '7');
const paymentId = id('pay', '8');
const inviteId = id('adi', '9');
const operation = { instanceId: 'operation_123', idempotencyKey: 'idempotency_123' };
const partyKey = 'sk_ntl_sandbox_fixture_only';
const agentKey = 'ak_ntl_sandbox_fixture_only';
const agentConfig = {
  environment: 'sandbox' as const,
  apiKey: agentKey,
  agentId,
  platformPartyId: platform,
};
const expected: NaturalRequestBinding = {
  requesterPartyId: requester,
  payerPartyId: payer,
  walletId,
  amount: 2600,
  currency: 'USD',
};
const relation = (type: string, value: string | null) => ({
  data: value === null ? null : { type, id: value },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function wallet(
  party = requester,
  value = walletId,
  balance: unknown = { available: 10000, total: 12000, currency: 'USD' },
) {
  return {
    data: {
      type: 'wallet',
      id: value,
      attributes: {
        status: 'active',
        walletType: 'standard',
        isDefault: true,
        displayName: 'Test wallet',
        balance,
      },
      relationships: { party: relation('party', party) },
    },
  };
}
function invitation(accepted = false) {
  return {
    type: 'agentDelegationInvitation',
    id: inviteId,
    attributes: {
      status: accepted ? 'ACCEPTED' : 'PENDING',
      effectiveStatus: accepted ? 'ACCEPTED' : 'PENDING',
      permissions: ['party.read', 'wallets.read', 'wallets.balance'],
    },
    relationships: {
      agent: relation('agent', agentId),
      customerParty: relation('party', accepted ? requester : null),
    },
  };
}
function request() {
  return {
    data: {
      type: 'paymentRequest',
      id: requestId,
      attributes: {
        amount: 2600,
        currency: 'USD',
        status: 'OPEN',
        payerCanPay: true,
        payerCanDecline: true,
        tags: { app_operation_id: operation.instanceId },
        fee: null,
        payerPartyId: payer,
        payerIdentifierType: 'party_id',
        payerIdentifier: payer,
        initiatorAgent: { id: agentId },
      },
      relationships: {
        requesterParty: relation('party', requester),
        payerParty: relation('party', payer),
        wallet: relation('wallet', walletId),
        payment: relation('payment', null),
      },
    },
  };
}
function payment() {
  return {
    data: {
      type: 'payment',
      id: paymentId,
      attributes: {
        amount: 2600,
        currency: 'USD',
        status: 'PROCESSING',
        tags: { app_operation_id: operation.instanceId },
        fee: null,
      },
      relationships: {
        sender: relation('party', payer),
        recipient: relation('party', requester),
        senderAgent: relation('agent', agentId),
        paymentRequest: relation('paymentRequest', requestId),
      },
    },
  };
}
function fakeAgent(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const transport = vi.fn<typeof fetch>(async (url, init) => responder(String(url), init!));
  return { transport, client: new NaturalAgentClient(agentConfig, { fetch: transport }) };
}
function create(client: NaturalAgentClient) {
  return client.createPaymentRequest({
    customerPartyId: requester,
    walletId,
    payerPartyId: payer,
    amount: 2600,
    currency: 'USD',
    operation,
  });
}
function moneyTransport(post: () => Response | Promise<Response>) {
  return fakeAgent((url, init) => {
    if (init.method === 'POST') return post();
    if (url.includes('/payment-requests/')) return json(request());
    if (url.includes(`/wallets/${payerWalletId}`)) return json(wallet(payer, payerWalletId));
    if (url.includes('/external-accounts/'))
      return json({
        data: {
          type: 'externalAccount',
          id: externalAccountId,
          attributes: {
            lastFour: '1234',
            status: 'active',
            connectionStatus: 'active',
            availableMethods: ['standard'],
            bankName: 'Test bank',
            accountName: null,
            accountType: 'checking',
          },
          relationships: { party: relation('party', payer) },
        },
      });
    return json(wallet());
  });
}
function fulfill(client: NaturalAgentClient, external = false) {
  return client.fulfillPaymentRequest({
    customerPartyId: payer,
    paymentRequestId: requestId,
    expected,
    paymentSource: external
      ? { type: 'external_account', externalAccountId }
      : { type: 'wallet', walletId: payerWalletId },
    operation,
  });
}

describe('sandbox credential and configuration boundary', () => {
  it('uses the explicit admin key or identical legacy alias without side effects', () => {
    expect(readProvisioningConfig({ NATURAL_API_KEY: partyKey })).toEqual({
      environment: 'sandbox',
      apiKey: partyKey,
    });
    expect(
      readProvisioningConfig({ NATURAL_API_KEY: partyKey, NATURAL_PROVISIONING_API_KEY: partyKey })
        .apiKey,
    ).toBe(partyKey);
  });
  it.each([
    { NATURAL_API_KEY: partyKey, NATURAL_PROVISIONING_API_KEY: 'sk_ntl_sandbox_other' },
    { NATURAL_API_KEY: 'sk_ntl_live_fixture' },
    { NATURAL_API_KEY: agentKey },
    { NATURAL_API_KEY: `${partyKey}\n` },
    { NATURAL_API_KEY: partyKey, NATURAL_API_BASE_URL: 'https://api.natural.com' },
    { NATURAL_API_KEY: partyKey, NATURAL_API_BASE_URL: `${NATURAL_SANDBOX_ORIGIN}/` },
    { NATURAL_API_KEY: partyKey, NATURAL_ENVIRONMENT: 'production' },
    {},
  ])('rejects unsupported or ambiguous configuration without exposing it', (env) => {
    expect(() => readProvisioningConfig(env)).toThrow(NaturalProviderError);
    try {
      readProvisioningConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('sk_ntl');
    }
  });
  it('requires an agent credential, exact agent ID, and platform deny ID', () => {
    expect(
      readAgentConfig({
        NATURAL_AGENT_KEY: agentKey,
        NATURAL_AGENT_ID: agentId,
        NATURAL_PLATFORM_PARTY_ID: platform,
      }),
    ).toEqual(agentConfig);
    expect(() =>
      readAgentConfig({
        NATURAL_AGENT_KEY: partyKey,
        NATURAL_AGENT_ID: agentId,
        NATURAL_PLATFORM_PARTY_ID: platform,
      }),
    ).toThrow(NaturalProviderError);
    expect(() =>
      readAgentConfig({ NATURAL_AGENT_KEY: agentKey, NATURAL_AGENT_ID: agentId }),
    ).toThrow(NaturalProviderError);
    expect(() => new NaturalAgentClient({ ...agentConfig, apiKey: partyKey })).toThrow(
      NaturalProviderError,
    );
  });
  it('provisioning never exposes financial commands and private fields do not serialize secrets', () => {
    const client = new NaturalProvisioningClient({ environment: 'sandbox', apiKey: partyKey });
    expect('fulfillPaymentRequest' in client).toBe(false);
    expect('createPaymentRequest' in client).toBe(false);
    expect(JSON.stringify(client)).toBe('{}');
    expect(JSON.stringify(new NaturalAgentClient(agentConfig))).toBe('{}');
  });
});

describe('sandbox provisioning wire contracts', () => {
  it('creates a synthetic PERSON, not a real phone/email invitation', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json(
        { data: [invitation()], meta: { customer: { partyId: requester, partyType: 'PERSON' } } },
        201,
      ),
    );
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      { fetch: transport },
    );
    const result = await client.createSandboxInvitation({
      agentId,
      permissions: ['party.read', 'wallets.read', 'wallets.balance'],
      operation,
    });
    expect(result.customerPartyId).toBe(requester);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(`${NATURAL_SANDBOX_ORIGIN}/simulations/invite-customer`);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${partyKey}`,
      'Idempotency-Key': operation.idempotencyKey,
      'X-Instance-ID': operation.instanceId,
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      data: {
        attributes: {
          agentIds: [agentId],
          permissions: ['party.read', 'wallets.read', 'wallets.balance'],
          type: 'PERSON',
        },
      },
    });
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', method: 'POST' });
  });
  it('rejects a created invitation for another agent or broadened permission set as uncertain', async () => {
    const wrong = invitation();
    wrong.attributes.permissions.push('payments.create');
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      {
        fetch: vi.fn(async () =>
          json({ data: [wrong], meta: { customer: { partyId: requester, partyType: 'PERSON' } } }),
        ),
      },
    );
    await expect(
      client.createSandboxInvitation({
        agentId,
        permissions: ['party.read', 'wallets.read', 'wallets.balance'],
        operation,
      }),
    ).rejects.toMatchObject({ reason: 'binding_mismatch', outcome: 'unknown' });
  });
  it('accepts only the expected invitation, agent, and customer', async () => {
    const transport = vi.fn<typeof fetch>(async () => json({ data: invitation(true) }));
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      { fetch: transport },
    );
    expect(
      (
        await client.acceptSandboxInvitation({
          invitationId: inviteId,
          customerPartyId: requester,
          agentId,
          operation,
        })
      ).status,
    ).toBe('ACCEPTED');
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({
      data: { attributes: { partyId: requester } },
    });
    const wrong = invitation(true);
    wrong.relationships.customerParty = relation('party', payer);
    transport.mockResolvedValueOnce(json({ data: wrong }));
    await expect(
      client.acceptSandboxInvitation({
        invitationId: inviteId,
        customerPartyId: requester,
        agentId,
        operation,
      }),
    ).rejects.toMatchObject({ reason: 'binding_mismatch', outcome: 'unknown' });
  });
  it('checks resource IDs and returns minimum connection metadata', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({
        data: {
          type: 'customer',
          id: requester,
          attributes: {
            name: 'Private name',
            email: 'private@example.test',
            delegation: { id: id('dlg', 'a'), status: 'ACTIVE', permissions: ['party.read'] },
            agents: [{ id: agentId, status: 'ACTIVE', permissions: ['party.read'] }],
          },
        },
      }),
    );
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      { fetch: transport },
    );
    const result = await client.getCustomer(requester);
    expect(JSON.stringify(result)).not.toContain('Private');
    transport.mockResolvedValueOnce(
      json({
        data: {
          type: 'agent',
          id: agentId,
          attributes: { status: 'ACTIVE' },
          relationships: { party: relation('party', platform) },
        },
      }),
    );
    expect((await client.getAgent(agentId)).partyId).toBe(platform);
  });
});

describe('explicit customer reads', () => {
  it('keeps missing balances unknown and rejects foreign wallet ownership', async () => {
    const { client, transport } = fakeAgent(() => json(wallet(requester, walletId, null)));
    expect((await client.getWallet({ customerPartyId: requester, walletId })).balance).toBeNull();
    expect(transport.mock.calls[0]![0]).toBe(
      `${NATURAL_SANDBOX_ORIGIN}/wallets/${walletId}?customerPartyId=${requester}`,
    );
    transport.mockResolvedValueOnce(json(wallet(payer)));
    await expect(client.getWallet({ customerPartyId: requester, walletId })).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'not_submitted',
    });
  });
  it('preserves wallet pagination rather than pretending a partial list is complete', async () => {
    const { client } = fakeAgent(() =>
      json({
        data: [wallet().data],
        meta: { pagination: { hasMore: true, nextCursor: 'cursor_a' } },
      }),
    );
    expect(await client.listWallets(requester)).toMatchObject({
      hasMore: true,
      nextCursor: 'cursor_a',
    });
  });
  it('rejects absent/platform actors and path injection locally', async () => {
    const { client, transport } = fakeAgent(() => json(wallet()));
    await expect(client.listWallets('')).rejects.toMatchObject({ outcome: 'not_submitted' });
    await expect(client.listWallets(platform)).rejects.toMatchObject({ outcome: 'not_submitted' });
    await expect(
      client.getWallet({ customerPartyId: requester, walletId: '../parties/me' }),
    ).rejects.toMatchObject({ outcome: 'not_submitted' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('verifies own party but does not confuse configured agent lookup with key attestation', async () => {
    const { client, transport } = fakeAgent(() =>
      json({
        data: { type: 'party', id: payer, attributes: { partyType: 'PERSON', status: 'ACTIVE' } },
      }),
    );
    await expect(client.getOwnParty()).rejects.toMatchObject({ reason: 'binding_mismatch' });
    transport.mockResolvedValueOnce(
      json({
        data: {
          type: 'agent',
          id: agentId,
          attributes: { status: 'ACTIVE' },
          relationships: { party: relation('party', platform) },
        },
      }),
    );
    expect(await client.getAgent()).toEqual({ id: agentId, status: 'ACTIVE', partyId: platform });
  });
});

describe('payment command identity and immutable wire binding', () => {
  it('creates one request with exact cents, actor, wallet, party payer, and stable operation headers', async () => {
    const { client, transport } = moneyTransport(() => json(request(), 201));
    const result = await create(client);
    expect(result).toMatchObject({
      id: requestId,
      amount: 2600,
      requesterPartyId: requester,
      payerPartyId: payer,
    });
    expect('walletId' in result).toBe(false);
    const posts = transport.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({
      data: {
        attributes: {
          customerPartyId: requester,
          walletId,
          amount: 2600,
          currency: 'USD',
          payer: { type: 'party_id', value: payer },
          tags: { app_operation_id: operation.instanceId },
        },
      },
    });
  });
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects invalid amount %s without dispatch',
    async (amount) => {
      const { client, transport } = moneyTransport(() => json(request()));
      await expect(
        client.createPaymentRequest({
          customerPartyId: requester,
          walletId,
          payerPartyId: payer,
          amount,
          currency: 'USD',
          operation,
        }),
      ).rejects.toMatchObject({ outcome: 'not_submitted' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'abc', 'bad\nheader', 'bad/path'])(
    'requires stable opaque operation identifiers',
    async (instanceId) => {
      const { client, transport } = moneyTransport(() => json(request()));
      await expect(
        client.createPaymentRequest({
          customerPartyId: requester,
          walletId,
          payerPartyId: payer,
          amount: 2600,
          currency: 'USD',
          operation: { ...operation, instanceId },
        }),
      ).rejects.toMatchObject({ outcome: 'not_submitted' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('blocks a request using a wallet owned by another customer before mutation', async () => {
    const { client, transport } = fakeAgent(() => json(wallet(payer)));
    await expect(create(client)).rejects.toMatchObject({ reason: 'binding_mismatch' });
    expect(transport.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('requires canonical amount, payer, and wallet match before fulfillment', async () => {
    const wrong = request();
    wrong.data.attributes.amount = 2601;
    const { client, transport } = fakeAgent(() => json(wrong));
    await expect(fulfill(client)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'not_submitted',
    });
    expect(transport.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each([false, true])(
    'fulfills using the approved exact source; no amount override (bank=%s)',
    async (external) => {
      const { client, transport } = moneyTransport(() => json(payment()));
      expect((await fulfill(client, external)).status).toBe('PROCESSING');
      const post = transport.mock.calls.find(([, init]) => init?.method === 'POST')!;
      expect(post[0]).toBe(`${NATURAL_SANDBOX_ORIGIN}/payment-requests/${requestId}/fulfill`);
      expect(JSON.parse(post[1]!.body as string)).toEqual({
        data: {
          attributes: {
            customerPartyId: payer,
            paymentSource: external
              ? { type: 'external_account', externalAccountId }
              : { type: 'wallet', walletId: payerWalletId },
            tags: { app_operation_id: operation.instanceId },
          },
        },
      });
      expect(post[1]!.headers).toMatchObject({
        Authorization: `Bearer ${agentKey}`,
        'Idempotency-Key': operation.idempotencyKey,
        'X-Instance-ID': operation.instanceId,
      });
    },
  );
  it('keeps a mismatched mutation response uncertain', async () => {
    const wrong = payment();
    wrong.data.relationships.senderAgent = relation('agent', id('agt', 'a'));
    const { client } = moneyTransport(() => json(wrong));
    await expect(fulfill(client)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'unknown',
    });
  });
  it('rejects contradictory payer relationship and attribute values', async () => {
    const wrong = request();
    wrong.data.relationships.payerParty = relation('party', requester);
    const { client } = moneyTransport(() => json(wrong));
    await expect(create(client)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'unknown',
    });
  });
  it('cancels as requester and leaves actual provider status visible during a race', async () => {
    const processing = request();
    processing.data.attributes.status = 'PROCESSING';
    const { client, transport } = moneyTransport(() => json(processing));
    expect(
      (
        await client.cancelPaymentRequest({
          customerPartyId: requester,
          paymentRequestId: requestId,
          expected,
          operation,
        })
      ).status,
    ).toBe('PROCESSING');
    const post = transport.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({
      data: { attributes: { customerPartyId: requester } },
    });
  });
  it('accepts a canonical return as a distinct current payment status', async () => {
    const returned = payment();
    returned.data.attributes.status = 'RETURNED';
    const { client } = fakeAgent(() => json(returned));
    expect(
      (
        await client.getPayment({
          customerPartyId: requester,
          paymentId,
          expected: {
            senderPartyId: payer,
            recipientPartyId: requester,
            paymentRequestId: requestId,
            amount: 2600,
            currency: 'USD',
          },
        })
      ).status,
    ).toBe('RETURNED');
  });
});

describe('bounded transport and failure semantics', () => {
  it.each([400, 401, 403, 404, 405, 422])(
    'marks definitive HTTP %s as rejected without echoing its body',
    async (status) => {
      const { client, transport } = moneyTransport(() =>
        json({ secret: partyKey, customer: 'private phone' }, status),
      );
      await expect(create(client)).rejects.toMatchObject({
        reason: 'http',
        status,
        outcome: 'rejected',
      });
      expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );
  it.each([408, 409, 429, 500, 502, 503])(
    'preserves uncertainty on HTTP %s and never automatically retries',
    async (status) => {
      const { client, transport } = moneyTransport(() =>
        json({ sensitive: 'do not echo' }, status),
      );
      await expect(create(client)).rejects.toMatchObject({
        reason: 'http',
        status,
        outcome: 'unknown',
      });
      expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );
  it('sanitizes network exceptions that contain credentials and PII', async () => {
    const { client } = moneyTransport(() => {
      throw new Error(`${partyKey} private user phone`);
    });
    let caught: unknown;
    try {
      await create(client);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: 'transport', outcome: 'unknown' });
    expect(String(caught)).not.toContain(partyKey);
    expect(String(caught)).not.toContain('phone');
    expect(caught).not.toHaveProperty('cause');
  });
  it('treats malformed 2xx JSON, missing fields, and redirects as unknown mutation outcomes', async () => {
    for (const response of [
      new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
      json({ data: {} }),
      new Response(null, { status: 302, headers: { location: 'https://api.natural.com' } }),
    ]) {
      const { client, transport } = moneyTransport(() => response);
      await expect(create(client)).rejects.toMatchObject({
        reason: 'invalid_response',
        outcome: 'unknown',
      });
      expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    }
  });
  it('bounds actual streamed bytes even without Content-Length', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        canceled = true;
      },
    });
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      {
        maxResponseBytes: 1024,
        fetch: vi.fn(
          async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
        ),
      },
    );
    await expect(client.getOwnParty()).rejects.toMatchObject({
      reason: 'invalid_response',
      outcome: 'not_submitted',
    });
    expect(canceled).toBe(true);
  });
  it('bounds stalled transport duration and aborts it', async () => {
    const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      { timeoutMs: 10, fetch: transport },
    );
    await expect(
      client.createSandboxInvitation({ agentId, permissions: ['party.read'], operation }),
    ).rejects.toMatchObject({ reason: 'timeout', outcome: 'unknown' });
    expect(transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('also cancels a stalled response stream after its deadline', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const client = new NaturalProvisioningClient(
      { environment: 'sandbox', apiKey: partyKey },
      {
        timeoutMs: 10,
        fetch: vi.fn(
          async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
        ),
      },
    );
    await expect(client.getOwnParty()).rejects.toMatchObject({
      reason: 'timeout',
      outcome: 'not_submitted',
    });
    expect(canceled).toBe(true);
  });
});
