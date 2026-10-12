import { z } from 'zod';

export const partyIdSchema = z.string().regex(/^pty_[0-9a-f]{32}$/);
export const agentIdSchema = z.string().regex(/^agt_[0-9a-f]{32}$/);
export const walletIdSchema = z.string().regex(/^wal_[0-9a-f]{32}$/);
export const externalAccountIdSchema = z.string().regex(/^eac_[0-9a-f]{32}$/);
export const paymentRequestIdSchema = z.string().regex(/^prq_[0-9a-f]{32}$/);
export const paymentIdSchema = z.string().regex(/^pay_[0-9a-f]{32}$/);
export const invitationIdSchema = z.string().regex(/^adi_[0-9a-f]{32}$/);
export const transferIdSchema = z.string().regex(/^trf_[0-9a-f]{32}$/);
export const centsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const signedCents = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const tags = z.record(z.string(), z.string());
const relation = <T extends string>(type: T, id: z.ZodString) =>
  z.object({ data: z.object({ type: z.literal(type), id }) });
const nullableRelation = <T extends string>(type: T, id: z.ZodString) =>
  z.object({ data: z.object({ type: z.literal(type), id }).nullable() });
const partyRelation = relation('party', partyIdSchema);
const nullableParty = nullableRelation('party', partyIdSchema);
const nullableAgent = nullableRelation('agent', agentIdSchema);

/** Tallie deliberately restricts these headers to opaque, printable operation IDs. */
export const operationSchema = z.strictObject({
  instanceId: z
    .string()
    .min(8)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/),
  idempotencyKey: z
    .string()
    .min(8)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type NaturalOperation = z.infer<typeof operationSchema>;

export const permissionSchema = z.enum([
  'disputes.read',
  'disputes.create',
  'payments.read',
  'payments.create',
  'external_parties.read',
  'external_parties.create',
  'direct.read',
  'direct.create',
  'external_accounts.create',
  'wallets.read',
  'wallets.balance',
  'wallets.create',
  'wallets.update',
  'wallets.fund',
  'wallets.deposit',
  'wallets.transfer',
  'wallets.withdraw',
  'party.read',
  'party.update',
  'payment_intents.create',
  'payment_intents.read',
  'card_payments.read',
  'refunds.read',
  'refunds.create',
  'voice_sessions.read',
  'voice_sessions.create',
  'chargebacks.read',
  'chargebacks.respond',
  'mandates.read',
  'enrollment.read',
  'cards.read',
]);
export type NaturalPermission = z.infer<typeof permissionSchema>;

export const partyResponse = z
  .object({
    data: z.object({
      type: z.literal('party'),
      id: partyIdSchema,
      attributes: z.object({
        partyType: z.enum(['PERSON', 'ORG']),
        status: z.enum(['PROVISIONAL', 'ACTIVE', 'SUSPENDED', 'INACTIVE']),
      }),
    }),
  })
  .transform(({ data }) => ({ id: data.id, ...data.attributes }));
export type NaturalParty = z.infer<typeof partyResponse>;

export const agentResponse = z
  .object({
    data: z.object({
      type: z.literal('agent'),
      id: agentIdSchema,
      attributes: z.object({ status: z.enum(['ACTIVE', 'REVOKED']) }),
      relationships: z.object({ party: partyRelation }),
    }),
  })
  .transform(({ data }) => ({
    id: data.id,
    status: data.attributes.status,
    partyId: data.relationships.party.data.id,
  }));
export type NaturalAgent = z.infer<typeof agentResponse>;

export const customerResponse = z
  .object({
    data: z.object({
      type: z.literal('customer'),
      id: partyIdSchema,
      attributes: z.object({
        delegation: z.object({
          id: z.string().regex(/^dlg_[0-9a-f]{32}$/),
          status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED']),
          permissions: z.array(z.string()),
        }),
        agents: z.array(
          z.object({ id: agentIdSchema, status: z.string(), permissions: z.array(z.string()) }),
        ),
      }),
    }),
  })
  .transform(({ data }) => ({ id: data.id, ...data.attributes }));
export type NaturalCustomer = z.infer<typeof customerResponse>;

const invitationStatus = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED']);
export const invitationResource = z
  .object({
    type: z.literal('agentDelegationInvitation'),
    id: invitationIdSchema,
    attributes: z.object({
      status: invitationStatus,
      effectiveStatus: invitationStatus,
      permissions: z.array(z.string()),
    }),
    relationships: z.object({
      agent: relation('agent', agentIdSchema),
      customerParty: nullableParty,
    }),
  })
  .transform((data) => ({
    id: data.id,
    agentId: data.relationships.agent.data.id,
    customerPartyId: data.relationships.customerParty.data?.id ?? null,
    ...data.attributes,
  }));
export const invitationResponse = z
  .object({ data: invitationResource })
  .transform(({ data }) => data);
export const inviteResponse = z
  .object({
    data: z.array(invitationResource).length(1),
    meta: z.object({
      customer: z.object({ partyId: partyIdSchema, partyType: z.literal('PERSON') }),
    }),
  })
  .transform(({ data, meta }) => ({ customerPartyId: meta.customer.partyId, invitations: data }));
export type NaturalInvitation = z.infer<typeof invitationResource>;
export type NaturalSandboxInvitation = z.infer<typeof inviteResponse>;
export const inviteInput = z.strictObject({
  agentId: agentIdSchema,
  permissions: z.array(permissionSchema).min(1).max(31),
  operation: operationSchema,
});
export type CreateSandboxInvitationInput = z.infer<typeof inviteInput>;
export const acceptInput = z.strictObject({
  invitationId: invitationIdSchema,
  customerPartyId: partyIdSchema,
  agentId: agentIdSchema,
  operation: operationSchema,
});
export type AcceptSandboxInvitationInput = z.infer<typeof acceptInput>;
export const fundSandboxCustomerInput = z.strictObject({
  customerPartyId: partyIdSchema,
  walletId: walletIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
  operation: operationSchema,
});
export type FundSandboxCustomerInput = z.infer<typeof fundSandboxCustomerInput>;
export const sandboxDepositResponse = z
  .object({
    data: z.object({
      type: z.literal('transfer'),
      id: transferIdSchema,
      attributes: z.object({
        type: z.literal('deposit'),
        amount: centsSchema,
        currency: z.literal('USD'),
        status: z.enum([
          'CREATED',
          'PROCESSING',
          'IN_REVIEW',
          'COMPLETED',
          'FAILED',
          'RETURNED',
          'APPROVAL_DENIED',
          'CANCELED',
        ]),
      }),
      relationships: z.object({
        party: partyRelation,
        wallet: relation('wallet', walletIdSchema),
      }),
    }),
  })
  .transform(({ data }) => ({
    id: data.id,
    ...data.attributes,
    partyId: data.relationships.party.data.id,
    walletId: data.relationships.wallet.data.id,
  }));
export type NaturalSandboxDeposit = z.infer<typeof sandboxDepositResponse>;
export const depositReadInput = z.strictObject({
  customerPartyId: partyIdSchema,
  walletId: walletIdSchema,
  transferId: transferIdSchema,
  amount: centsSchema,
});
export type GetDepositInput = z.infer<typeof depositReadInput>;

export const paginationSchema = z
  .object({ hasMore: z.boolean(), nextCursor: z.string().nullable() })
  .refine((value) => !value.hasMore || !!value.nextCursor);
export const walletResource = z
  .object({
    type: z.literal('wallet'),
    id: walletIdSchema,
    attributes: z.object({
      status: z.enum(['active', 'frozen', 'closed']),
      walletType: z.enum(['standard', 'vault']),
      isDefault: z.boolean(),
      agentDefault: z.boolean().optional(),
      displayName: z.string().nullable(),
      balance: z
        .object({ available: signedCents, total: signedCents, currency: z.literal('USD') })
        .nullable(),
    }),
    relationships: z.object({ party: partyRelation }),
  })
  .transform((data) => ({
    id: data.id,
    partyId: data.relationships.party.data.id,
    ...data.attributes,
    agentDefault: data.attributes.agentDefault ?? null,
  }));
export const walletResponse = z.object({ data: walletResource }).transform(({ data }) => data);
export const walletsResponse = z
  .object({ data: z.array(walletResource), meta: z.object({ pagination: paginationSchema }) })
  .transform(({ data, meta }) => ({ wallets: data, ...meta.pagination }));
export type NaturalWallet = z.infer<typeof walletResource>;
export type NaturalWalletPage = z.infer<typeof walletsResponse>;

export const externalAccountResource = z
  .object({
    type: z.literal('externalAccount'),
    id: externalAccountIdSchema,
    attributes: z.object({
      lastFour: z.string(),
      status: z.enum(['pending', 'new', 'active', 'disabled', 'deleted', 'unknown']),
      connectionStatus: z.enum(['active', 'login_required', 'disconnected']),
      availableMethods: z.array(z.enum(['standard', 'instant'])),
      bankName: z.string().nullable(),
      accountName: z.string().nullable(),
      accountType: z.enum(['checking', 'savings', 'unknown']).nullable(),
    }),
    relationships: z.object({ party: partyRelation }),
  })
  .transform((data) => ({
    id: data.id,
    partyId: data.relationships.party.data.id,
    ...data.attributes,
  }));
export const externalAccountResponse = z
  .object({ data: externalAccountResource })
  .transform(({ data }) => data);
export const externalAccountsResponse = z
  .object({
    data: z.array(externalAccountResource),
    meta: z.object({ pagination: paginationSchema }),
  })
  .transform(({ data, meta }) => ({ externalAccounts: data, ...meta.pagination }));
export type NaturalExternalAccount = z.infer<typeof externalAccountResource>;
export type NaturalExternalAccountPage = z.infer<typeof externalAccountsResponse>;

const requestAttributes = z.object({
  amount: centsSchema,
  currency: z.literal('USD'),
  status: z.enum([
    'OPEN',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'RETURNED',
    'CANCELED',
    'DECLINED',
    'EXPIRED',
  ]),
  payerCanPay: z.boolean(),
  payerCanDecline: z.boolean(),
  tags,
  fee: z
    .object({
      amount: centsSchema,
      currency: z.literal('USD'),
      payer: z.literal('recipient'),
      applied: z.literal('deducted'),
    })
    .nullable(),
  payerPartyId: partyIdSchema.nullable(),
  payerIdentifierType: z.enum(['email', 'phone', 'party_id', 'agent_id', 'handle']),
  payerIdentifier: z.string(),
  initiatorAgent: z.object({ id: agentIdSchema }).nullable(),
});
const requestRelationships = z.object({ requesterParty: partyRelation, payerParty: nullableParty });
const requestCreated = z.object({
  type: z.literal('paymentRequest'),
  id: paymentRequestIdSchema,
  attributes: requestAttributes,
  relationships: requestRelationships,
});
function normalizeRequest(data: z.infer<typeof requestCreated>) {
  const { payerPartyId, initiatorAgent, ...attributes } = data.attributes;
  return {
    id: data.id,
    ...attributes,
    requesterPartyId: data.relationships.requesterParty.data.id,
    payerPartyId: data.relationships.payerParty.data?.id ?? null,
    reportedPayerPartyId: payerPartyId,
    initiatorAgentId: initiatorAgent?.id ?? null,
  };
}
/** Creation does not return a wallet relationship. Persist its ID, then read canonical detail. */
export const requestCreatedResponse = z
  .object({ data: requestCreated })
  .transform(({ data }) => normalizeRequest(data));
export type NaturalPaymentRequestAcknowledgement = z.infer<typeof requestCreatedResponse>;
export const requestResponse = z
  .object({
    data: requestCreated.extend({
      relationships: requestRelationships.extend({
        wallet: relation('wallet', walletIdSchema),
        payment: nullableRelation('payment', paymentIdSchema),
      }),
    }),
  })
  .transform(({ data }) => ({
    ...normalizeRequest(data),
    walletId: data.relationships.wallet.data.id,
    paymentId: data.relationships.payment.data?.id ?? null,
  }));
export type NaturalPaymentRequest = z.infer<typeof requestResponse>;

export const requestBindingSchema = z.strictObject({
  requesterPartyId: partyIdSchema,
  walletId: walletIdSchema,
  payerPartyId: partyIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
});
export type NaturalRequestBinding = z.infer<typeof requestBindingSchema>;
export const createRequestInput = z.strictObject({
  customerPartyId: partyIdSchema,
  walletId: walletIdSchema,
  payerPartyId: partyIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
  description: z.string().max(80).optional(),
  operation: operationSchema,
});
export type CreatePaymentRequestInput = z.infer<typeof createRequestInput>;
export const requestReadInput = z.strictObject({
  customerPartyId: partyIdSchema,
  paymentRequestId: paymentRequestIdSchema,
  expected: requestBindingSchema,
});
export type GetPaymentRequestInput = z.infer<typeof requestReadInput>;
export const cancelRequestInput = requestReadInput.extend({ operation: operationSchema });
export type CancelPaymentRequestInput = z.infer<typeof cancelRequestInput>;
export const paymentSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('wallet'), walletId: walletIdSchema }),
  z.strictObject({
    type: z.literal('external_account'),
    externalAccountId: externalAccountIdSchema,
  }),
]);
export type NaturalPaymentSource = z.infer<typeof paymentSourceSchema>;
export const fulfillRequestInput = requestReadInput.extend({
  paymentSource: paymentSourceSchema,
  operation: operationSchema,
});
export type FulfillPaymentRequestInput = z.infer<typeof fulfillRequestInput>;

export const createDirectWalletPaymentInput = z.strictObject({
  customerPartyId: partyIdSchema,
  walletId: walletIdSchema,
  recipientPartyId: partyIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
  description: z.string().max(80).optional(),
  operation: operationSchema,
});
export type CreateDirectWalletPaymentInput = z.infer<typeof createDirectWalletPaymentInput>;

const paymentResource = z
  .object({
    type: z.literal('payment'),
    id: paymentIdSchema,
    attributes: z.object({
      amount: centsSchema,
      currency: z.literal('USD'),
      status: z.enum([
        'CREATED',
        'PROCESSING',
        'PENDING_CLAIM',
        'IN_REVIEW',
        'COMPLETED',
        'FAILED',
        'RETURNED',
        'APPROVAL_DENIED',
        'CANCELED',
      ]),
      tags,
      fee: z
        .object({
          amount: centsSchema,
          currency: z.literal('USD'),
          payer: z.literal('sender'),
          applied: z.literal('on_top'),
        })
        .nullable(),
    }),
    relationships: z.object({
      sender: nullableParty,
      recipient: nullableParty,
      senderAgent: nullableAgent,
      paymentRequest: nullableRelation('paymentRequest', paymentRequestIdSchema),
    }),
  })
  .transform((data) => ({
    id: data.id,
    ...data.attributes,
    senderPartyId: data.relationships.sender.data?.id ?? null,
    recipientPartyId: data.relationships.recipient.data?.id ?? null,
    senderAgentId: data.relationships.senderAgent.data?.id ?? null,
    paymentRequestId: data.relationships.paymentRequest.data?.id ?? null,
  }));
export const paymentResponse = z.object({ data: paymentResource }).transform(({ data }) => data);
export type NaturalPayment = z.infer<typeof paymentResponse>;
export const paymentsResponse = z
  .object({ data: z.array(paymentResource), meta: z.object({ pagination: paginationSchema }) })
  .transform(({ data, meta }) => ({ payments: data, ...meta.pagination }));
export type NaturalPaymentPage = z.infer<typeof paymentsResponse>;
export const listPaymentsInput = z.strictObject({
  customerPartyId: partyIdSchema,
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListPaymentsInput = z.infer<typeof listPaymentsInput>;
export const directPaymentBindingSchema = z.strictObject({
  senderPartyId: partyIdSchema,
  recipientPartyId: partyIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
});
export type NaturalDirectPaymentBinding = z.infer<typeof directPaymentBindingSchema>;
export const directPaymentReadInput = z.strictObject({
  customerPartyId: partyIdSchema,
  paymentId: paymentIdSchema,
  expected: directPaymentBindingSchema,
});
export type GetDirectPaymentInput = z.infer<typeof directPaymentReadInput>;
export const paymentBindingSchema = z.strictObject({
  senderPartyId: partyIdSchema,
  recipientPartyId: partyIdSchema,
  paymentRequestId: paymentRequestIdSchema,
  amount: centsSchema,
  currency: z.literal('USD'),
});
export type NaturalPaymentBinding = z.infer<typeof paymentBindingSchema>;
export const paymentReadInput = z.strictObject({
  customerPartyId: partyIdSchema,
  paymentId: paymentIdSchema,
  expected: paymentBindingSchema,
});
export type GetPaymentInput = z.infer<typeof paymentReadInput>;
