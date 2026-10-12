import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NaturalProductionConnectClient,
  PRODUCTION_CONNECT_PERMISSIONS,
  readProductionConnectConfig,
} from './production-connect';
import { ProductionConnectTransport } from './transport';

const id = (prefix: string, value: string) => `${prefix}_${value.repeat(32)}`;
const platform = id('pty', '1');
const agent = id('agt', '2');
const invitation = id('adi', '3');
const customer = id('pty', '4');
const event = id('evt', '5');
const config = {
  environment: 'production' as const,
  apiKey: 'sk_ntl_prod_fixture_only',
  agentId: agent,
  platformPartyId: platform,
  appOrigin: 'https://tallie.example',
};
const input = {
  verifiedPhone: '+12025550101',
  returnState: 'a'.repeat(43),
  perTransactionLimitMinor: 10_000,
  operation: { instanceId: 'test_instance_1', idempotencyKey: 'test_invitation_1' },
};
const verification = { eventId: event, invitationId: invitation, perTransactionLimitMinor: 10_000 };
function fixtures() {
  return {
    party: {
      data: { type: 'party', id: platform, attributes: { partyType: 'ORG', status: 'ACTIVE' } },
    },
    agent: {
      data: {
        type: 'agent',
        id: agent,
        attributes: { status: 'ACTIVE' },
        relationships: { party: { data: { type: 'party', id: platform } } },
      },
    },
    invitation: {
      data: [
        {
          type: 'agentDelegationInvitation',
          id: invitation,
          attributes: {
            phone: input.verifiedPhone,
            url: `https://www.natural.com/connect/${invitation}`,
            permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
            limits: { perTransaction: 10_000 },
            status: 'PENDING',
            effectiveStatus: 'PENDING',
            expiresAt: '2027-01-01T00:00:00Z',
            redirectUrl: `${config.appOrigin}/payments/connect/return?state=${input.returnState}`,
          },
          relationships: {
            agent: { data: { type: 'agent', id: agent } },
            customerParty: { data: null },
          },
        },
      ],
      meta: { failedRecipients: [] as unknown[], alreadyConnected: [] as unknown[] },
    },
    event: {
      data: {
        type: 'event',
        id: event,
        attributes: {
          eventType: 'agent_delegation_invitation.accepted',
          resourceId: invitation,
          resourceType: 'agent_delegation_invitation',
          payload: {
            object: {
              invitationId: invitation,
              agentId: agent,
              delegateePartyId: platform,
              delegatorPartyId: customer,
              status: 'accepted',
              permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
              limits: { perTransactionCents: 10_000 },
            },
          },
        },
        relationships: { party: { data: { type: 'party', id: platform } } },
      },
    },
    customer: {
      data: {
        type: 'customer',
        id: customer,
        attributes: {
          delegation: {
            id: id('dlg', '6'),
            status: 'ACTIVE',
            permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
          },
          agents: [
            {
              id: agent,
              status: 'ACTIVE',
              permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
              limits: { perTransaction: 10_000 as number | null },
            },
          ],
        },
      },
    },
  };
}
function fixtureClient(change?: (data: ReturnType<typeof fixtures>) => void) {
  const data = fixtures();
  change?.(data);
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    const response =
      path === '/parties/me'
        ? data.party
        : path.startsWith('/agents/')
          ? data.agent
          : path === '/customers/invitations'
            ? data.invitation
            : path.startsWith('/events/')
              ? data.event
              : path.startsWith('/customers/')
                ? data.customer
                : null;
    if (!response) throw new Error('unexpected request');
    return Response.json(response);
  });
  return { client: new NaturalProductionConnectClient(config, { fetch: fetcher }), fetcher };
}

describe('production hosted Connect foundation', () => {
  it('requires independently named production configuration', () => {
    expect(() =>
      readProductionConnectConfig({
        NATURAL_API_KEY: config.apiKey,
        NATURAL_AGENT_ID: agent,
        NATURAL_PLATFORM_PARTY_ID: platform,
        APP_ORIGIN: config.appOrigin,
      }),
    ).toThrow();
    expect(
      readProductionConnectConfig({
        NATURAL_PRODUCTION_API_KEY: config.apiKey,
        NATURAL_PRODUCTION_AGENT_ID: agent,
        NATURAL_PRODUCTION_PLATFORM_PARTY_ID: platform,
        APP_ORIGIN: config.appOrigin,
      }),
    ).toEqual(config);
    expect(
      () => new NaturalProductionConnectClient({ ...config, apiKey: 'sk_ntl_sandbox_fixture' }),
    ).toThrow();
    expect(
      () => new NaturalProductionConnectClient({ ...config, appOrigin: 'http://localhost:3001' }),
    ).toThrow();
  });

  it('creates exactly one targeted phone invitation with a fixed return origin and bounded grant', async () => {
    const { client, fetcher } = fixtureClient();
    const result = await client.createInvitation(input);
    expect(result).toEqual({
      invitationId: invitation,
      url: `https://www.natural.com/connect/${invitation}`,
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, request] = fetcher.mock.calls[2]!;
    expect(url).toBe('https://api.natural.com/customers/invitations');
    expect(request?.redirect).toBe('error');
    expect(request?.headers).toMatchObject({ 'Idempotency-Key': input.operation.idempotencyKey });
    expect(JSON.parse(String(request?.body))).toEqual({
      data: {
        attributes: {
          recipients: [{ type: 'phone', value: input.verifiedPhone }],
          agents: [
            {
              agentId: agent,
              permissions: [...PRODUCTION_CONNECT_PERMISSIONS],
              limits: { perTransaction: 10_000 },
            },
          ],
          redirectUrl: `${config.appOrigin}/payments/connect/return?state=${input.returnState}`,
        },
      },
    });
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith('https://api.natural.com/')),
    ).toBe(true);
  });

  it.each([
    { ...input, verifiedPhone: '2025550101' },
    { ...input, perTransactionLimitMinor: 10_001 },
    { ...input, perTransactionLimitMinor: 0 },
    { ...input, returnState: '../redirect' },
    { ...input, returnUrl: 'https://attacker.example' },
    { ...input, customerPartyId: customer },
  ])('rejects unbounded or client-controlled input before any provider calls', async (badInput) => {
    const { client, fetcher } = fixtureClient();
    await expect(client.createInvitation(badInput)).rejects.toMatchObject({
      reason: 'invalid_input',
      outcome: 'not_submitted',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.data[0]!.attributes.phone = '+12025550102';
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.data[0]!.relationships.agent.data.id = id('agt', '9');
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.data[0]!.attributes.url = 'https://attacker.example/connect';
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.data[0]!.attributes.url += '?next=https://attacker.example';
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.data[0]!.attributes.limits.perTransaction = 9_999;
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.meta.alreadyConnected = [{}];
    },
    (data: ReturnType<typeof fixtures>) => {
      data.invitation.meta.failedRecipients = [{}];
    },
  ])(
    'treats malformed, partial, already-connected or mismatched responses as uncertain',
    async (change) => {
      const { client } = fixtureClient(change);
      await expect(client.createInvitation(input)).rejects.toMatchObject({ outcome: 'unknown' });
    },
  );

  it('does not invite from a different platform or revoked agent', async () => {
    const { client, fetcher } = fixtureClient((data) => {
      data.agent.data.attributes.status = 'REVOKED';
    });
    await expect(client.createInvitation(input)).rejects.toMatchObject({
      reason: 'binding_mismatch',
      outcome: 'not_submitted',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('verifies a platform-owned accepted event and the customer grant without granting debit authority', async () => {
    const { client, fetcher } = fixtureClient();
    await expect(client.verifyAcceptedConnection(verification)).resolves.toEqual({
      customerPartyId: customer,
      delegationId: id('dlg', '6'),
      agentId: agent,
      perTransactionLimitMinor: 10_000,
      invitationAccepted: true,
      moneyMovementEnabled: false,
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/parties/me',
      `/agents/${agent}`,
      `/events/${event}`,
      `/customers/${customer}`,
    ]);
    expect(fetcher.mock.calls.every(([, request]) => request?.method === 'GET')).toBe(true);
  });

  it.each([
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.id = id('evt', '9');
    },
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.attributes.payload.object.invitationId = id('adi', '9');
    },
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.attributes.payload.object.agentId = id('agt', '9');
    },
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.attributes.payload.object.delegateePartyId = customer;
    },
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.relationships.party.data.id = customer;
    },
    (data: ReturnType<typeof fixtures>) => {
      data.event.data.relationships.party.data.id = id('pty', '9');
    },
    (data: ReturnType<typeof fixtures>) => {
      data.customer.data.attributes.delegation.status = 'REVOKED';
    },
    (data: ReturnType<typeof fixtures>) => {
      data.customer.data.attributes.agents[0]!.status = 'REVOKED';
    },
    (data: ReturnType<typeof fixtures>) => {
      data.customer.data.attributes.agents[0]!.limits.perTransaction = 100_000;
    },
    (data: ReturnType<typeof fixtures>) => {
      data.customer.data.attributes.agents[0]!.limits.perTransaction = null;
    },
    (data: ReturnType<typeof fixtures>) => {
      data.customer.data.attributes.agents[0]!.permissions.pop();
    },
  ])('rejects stale, unrelated or widened acceptance/grants', async (change) => {
    await expect(
      fixtureClient(change).client.verifyAcceptedConnection(verification),
    ).rejects.toMatchObject({ outcome: 'not_submitted' });
  });

  it('cannot call money, arbitrary read or simulation paths through production Connect transport', () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new ProductionConnectTransport(config.apiKey, { fetch: fetcher });
    for (const path of [
      '/payments',
      '/transfers/deposit',
      '/simulations/invite-customer',
      '//attacker.example',
      '/parties/me?token=x',
    ]) {
      expect(() => transport.request(path, z.unknown())).toThrow();
      expect(() =>
        transport.request(path, z.unknown(), { attributes: {}, operation: input.operation }),
      ).toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts provider bodies and does not automatically retry an uncertain invitation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('secret body');
    });
    const client = new NaturalProductionConnectClient(config, { fetch: fetcher });
    await expect(client.verifyPlatform()).rejects.toMatchObject({
      reason: 'transport',
      message: 'Natural transport.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
