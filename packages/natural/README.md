# Natural adapters

Typed, validated REST integration with independent sandbox and production clients. Sandbox clients remain pinned to `https://api.sandbox.natural.com`. Production clients support hosted customer activation and read-only wallet/linked-bank discovery only; they cannot send payments, fund wallets, withdraw or invoke simulations. Arbitrary origins and automatic mutation retries are unsupported. Public contract inspected September 26, 2026: OpenAPI SHA-256 `ca3882d75a009fcdcffecd1736237a6ccc9fb29113145df345c539b0fa63c32e`. The automated provider tests inject synthetic responses; they establish implementation/transport behavior, not authenticated provider behavior. See the [Natural integration runbook](../../docs/technical/natural-integration.md) for recorded sandbox evidence and the local test procedure.

## Credentials and ownership

- `readProvisioningConfig(env)` accepts `NATURAL_PROVISIONING_API_KEY` (`sk_ntl_sandbox_…`), with `NATURAL_API_KEY` as a temporary alias. Conflicting values fail closed. The resulting `NaturalProvisioningClient` reads identities, creates/accepts simulated PERSON invitations, and simulates a test deposit into an explicit customer wallet through `fundSandboxCustomer`. Payment sends and customer wallet reads use agent credentials.
- `readAgentConfig(env)` requires `NATURAL_AGENT_KEY` (`ak_ntl_sandbox_…`), `NATURAL_AGENT_ID`, and `NATURAL_PLATFORM_PARTY_ID`. `NaturalAgentClient` requires an explicit customer context on every customer read/command and refuses the platform as the customer actor. Resource IDs use ordinary `pty_`, `agt_`, `wal_`, etc. prefixes in sandbox too.
- `NATURAL_ENVIRONMENT`, when set, must be `sandbox`. `NATURAL_API_BASE_URL`, when set, must match the exact sandbox origin. Configuration helpers are pure and perform no I/O.
- `getOwnParty` and `getAgent` verify resource identity/ownership; they **do not attest which agent a supplied key belongs to**. Public API has no credential-self endpoint. Deployment must independently verify key/agent pairing through controlled provisioning or an operator. Money responses check the configured initiator/sender agent; their supported scope is requests/payments created through this Tallie agent, not arbitrary third-party requests.

Do not put keys or these configuration objects in browser responses or logs. Clients use private fields and transport errors never include credentials, response bodies, provider error causes, request URLs, or customer details.

## Caller responsibilities

Persist an operation, immutable input, actor, instance ID and idempotency key **before** a mutation. Use an operation lease and retain the same binding across any deliberate retry. Never automatically replace an uncertain operation. Errors expose:

- `not_submitted`: this attempt did not submit a mutation (input/config/read/preflight failure).
- `rejected`: a mutation returned a narrowly classified definitive HTTP rejection.
- `unknown`: a mutation may have executed (network/timeout, 409/429/5xx, malformed or mismatched response, etc.). Reconcile before doing anything else.

These labels describe this transport attempt; a failed preflight cannot erase an earlier attempt's uncertainty. This package does not grant user consent, enforce an operation journal, or implement payment reconciliation. Production Connect checks the current delegation at activation; that snapshot is not continuing debit authority. Application services own fresh authorization, fees and the operation lifecycle. Null wallet balance/fee stays unknown, never zero. Amounts are positive safe-integer USD cents. Fee amounts follow the reviewed schema's positive-or-null contract.

Mutation preflights read the expected wallet/request and exact source ownership; they do not select a mutable default source. A fulfillment body never overrides the provider request amount. Response binding checks exact parties, amount, currency, request and originating agent. A create-request response has **no wallet relationship** in the reviewed contract: persist its acknowledgment ID and then read canonical detail before confirming the receiving wallet. Cancellation returns canonical status without inventing success in a fulfill/cancel race.

## Sandbox customer setup

`createSandboxInvitation` calls `/simulations/invite-customer`, sets `type: PERSON`, includes one explicit agent and permissions, and uses the supplied stable operation headers. It creates a synthetic identity, not a real phone/email invitation. `acceptSandboxInvitation` binds the returned invitation to its exact test customer and agent. The caller must verify the resulting active customer delegation and agent permissions before permitting further use. This is not evidence that a real consumer's KYC or financial onboarding is approved.

`fundSandboxCustomer` calls `/simulations/customers/{customerPartyId}/transfers/deposit` with the provisioning credential, an explicit wallet, and the supplied stable operation headers. It checks that the customer is distinct from the provisioning party and has an active delegation, then binds the response to the exact customer, wallet, amount, currency, and deposit type. Before calling it, the application gateway must use `NaturalAgentClient.getWallet` to validate the wallet's ownership, active status, and standard type. Customer wallet access requires the bound agent credential; the provisioning credential cannot substitute for this check. This operation adds sandbox test dollars only.

Wallet listing returns `{wallets, hasMore, nextCursor}`. The public wallet-list schema has no cursor parameter; callers must treat `hasMore` as incomplete instead of silently claiming a complete balance/source list. External accounts have documented cursor/limit pagination.

## Production hosted activation

`NaturalProductionConnectClient` accepts only `NATURAL_PRODUCTION_API_KEY` (`sk_ntl_prod_…`), `NATURAL_PRODUCTION_AGENT_ID`, `NATURAL_PRODUCTION_PLATFORM_PARTY_ID` and a public HTTPS `APP_ORIGIN`. Its internal transport allows one invitation endpoint and canonical party, agent, customer and event reads at the fixed `https://api.natural.com` origin. Production names never fall back to sandbox variables.

The application must persist the operation before `createInvitation`, obtain the target phone from the authenticated account, and store the returned invitation URL encrypted. The client offers exactly one agent to one canonical US phone number, with five permissions (`party.read`, `wallets.read`, `wallets.balance`, `payments.read`, `payments.create`) and a positive per-transaction cap of at most $100. The cap limits the offered delegation; it does not establish app consent to a payment. Partial, already-connected or mismatched responses fail closed. The published invitation contract does not establish safe idempotent replay, so an unknown result requires reconciliation, not a fresh invitation.

Natural's hosted page handles identity verification and customer acceptance. The fixed return path is `/payments/connect/return?state=…`; callers generate random state, store its hash and bind it to the account and operation. A return is navigation, never proof of acceptance. `verifyAcceptedConnection` reads the canonical `agent_delegation_invitation.accepted` event, binds the exact saved invitation, customer, platform and agent, then re-reads the active customer/agent grant and cap. It returns `moneyMovementEnabled: false`.

`NaturalProductionWalletClient` uses a separate `NATURAL_PRODUCTION_AGENT_KEY` (`ak_ntl_prod_…`). It requires a complete customer wallet inventory and exactly one `agentDefault: true`, then re-reads that exact wallet and checks active/standard status and ownership. It never substitutes the customer's own `isDefault` wallet. If the inventory reports `hasMore`, it fails closed because the published endpoint has no cursor or limit input. Missing currency remains unknown. Neither client proves which agent an agent key authenticates as; preserve the provider's key-issuance binding evidence independently.

### Contract and evidence boundaries

- [Invite a customer](https://docs.natural.com/guides/connect/invite-customer): phone invitations require Tallie to deliver the returned URL. Sandbox phone invitations are unsupported; simulated acceptance is not a test of this production flow.
- [Manage customer access](https://docs.natural.com/guides/connect/manage-access): the provider binds identified recipients to their customer and exposes current grants. Public guidance does not explicitly prove how forwarded phone links are rejected or the exact phone is re-verified. Verify this in the hosted flow before treating a connection as a live payer identity. Unknown/expired invitation recovery remains application release work.
- [Event catalog](https://docs.natural.com/api-reference/event-catalog) and [OpenAPI](https://docs.natural.com/api-reference/openapi.json): webhook invitation snapshots use `invitationId`; REST event detail uses `attributes.payload.object`. The accepted example's source is the customer party. The adapter requires that source; a different provider shape fails closed pending verification.
- [Authentication](https://docs.natural.com/api-reference/authentication): party keys and agent keys carry different authority; reading `/parties/me` does not prove the configured agent-key pairing. Agent keys have a fixed provider policy. The invitation permission enum has no `transfers.read`; do not invent an additional grant from an endpoint's name.
- [Deposit and withdraw](https://docs.natural.com/guides/transfers/deposit-and-withdraw): real bank linking, deposit availability, holds, fees and cash-out require a separate supported journey. These production clients do not implement it.

Production connection tests use injected responses only. No real customer invitation, provider webhook delivery, production credential binding, KYC acceptance, bank funding or payment was verified by these tests. A saved `connected` state records activation evidence; it does not replace fresh authorization or revocation checks before future money movement.

## Production linked-bank discovery

`NaturalProductionBankClient` and `readProductionBankConfig(env)` use only the independently named production agent key, agent ID and platform party ID. The internal `ProductionBankTransport` permits GET `/parties/me` and customer-bound `/external-accounts` list/detail reads at the fixed production origin. It has no bank-linking, deletion, deposit, withdrawal or payment method. Callers must obtain `customerPartyId` from the authenticated account's accepted connection, never directly from the browser.

- `listLinkedBanks({ customerPartyId, cursor?, limit? })` returns one explicit page, default 20/max 100 accounts, with `hasMore` and `nextCursor`. Cursors are encoded and bounded. A page is not a complete inventory; an empty partial page does not prove the customer has no banks. Duplicate IDs, foreign owners, oversized pages, inconsistent pagination and a repeated input cursor fail closed.
- `getLinkedBank({ customerPartyId, externalAccountId })` rereads the exact selected account and binds both returned account and owner. This refreshes display readiness; it cannot authorize a transfer.
- Both methods validate the active platform credential owner. An independent issuance record must establish which agent the key belongs to; `/parties/me` alone cannot prove that binding.
- Display DTOs contain only ID, institution name, exactly four account digits, account type, `readiness`, and `withdrawalMethods`. Provider account names, account/routing numbers, arbitrary metadata and party identifiers are omitted. A response accidentally putting a full account number in `lastFour` is rejected.
- `readiness: connected` requires both `status: active` and `connectionStatus: active`; active accounts needing login/reconnection become `relink_required`, new/pending accounts remain `pending`, and disabled/deleted/unknown accounts are `unavailable`. Withdrawal methods are exposed only for connected accounts. These fields are not proof of verified bank ownership, permission to debit, sufficient funds, instant-withdrawal access or eventual settlement. The public bank resource has no separate verification flag.

**Permission boundary:** the reviewed [OpenAPI](https://docs.natural.com/api-reference/openapi.json) explicitly requires a connected agent's `wallets.read` for customer bank reads. Current Connect invitations already request it; discovery adds no permissions. The invitation enum includes `wallets.deposit` and `wallets.withdraw`, but the reviewed transfer/fulfillment operation descriptions do not establish the exact connected-customer mutation grant combinations. There are no `payment_requests.*` entries in that enum. Do not infer additional scopes or assume the existing five grants authorize bank funding/cash-out.

**Selected next flow, not implemented money movement:** customers link their own bank through their Natural dashboard. Start with standard ACH, explicit source/destination and amount/fee review for every debit or withdrawal, fresh confirmation and one durable operation identity. Do not automatically top up wallets. Keep unavailable fees and expected availability unknown until supported account/provider evidence exists. Instant withdrawals, fee policy, exact grants and bank verification still need account-specific evidence. See [bank linking](https://docs.natural.com/guides/concepts/external-accounts), [deposit/withdraw](https://docs.natural.com/guides/transfers/deposit-and-withdraw) and [bank-funded requests](https://docs.natural.com/guides/payments/fulfill-or-decline-request).

**Implementation evidence:** 37 injected-response bank tests cover credentials/origins, masking, ownership, pagination, connection health, canonical detail changes, unknown metadata and safe errors. All 149 Natural adapter tests and package TypeScript passed at this subtask's checkpoint. No bank credential, real bank link, bank transfer, provider delivery or hosted runtime was exercised by these tests. The founder's local-test/release gate remains active.

## Verification

```sh
npx tsc --noEmit -p packages/natural/tsconfig.json
npx vitest run packages/natural/src
```

Fetch is injectable for tests; the production transport still pins the origin, refuses redirects, enforces a deadline across fetching/reading, bounds actual response bytes, validates parsed output, and makes one attempt. No authenticated provider call is made by these tests.
