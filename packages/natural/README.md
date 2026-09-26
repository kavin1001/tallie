# Natural sandbox adapter

Typed, validated REST integration for the fixed `https://api.sandbox.natural.com` origin. Production credentials, arbitrary origins, and automatic mutation retries are unsupported. Public contract inspected September 26, 2026: OpenAPI SHA-256 `ca3882d75a009fcdcffecd1736237a6ccc9fb29113145df345c539b0fa63c32e`. These are implementation/transport tests with synthetic fixtures, not authenticated sandbox evidence.

## Credentials and ownership

- `readProvisioningConfig(env)` accepts `NATURAL_PROVISIONING_API_KEY` (`sk_ntl_sandbox_…`), with `NATURAL_API_KEY` as a temporary alias. Conflicting values fail closed. The resulting `NaturalProvisioningClient` only reads identities and creates/accepts simulated PERSON invitations. It exposes no money commands.
- `readAgentConfig(env)` requires `NATURAL_AGENT_KEY` (`ak_ntl_sandbox_…`), `NATURAL_AGENT_ID`, and `NATURAL_PLATFORM_PARTY_ID`. `NaturalAgentClient` requires an explicit customer context on every customer read/command and refuses the platform as the customer actor. Resource IDs use ordinary `pty_`, `agt_`, `wal_`, etc. prefixes in sandbox too.
- `NATURAL_ENVIRONMENT`, when set, must be `sandbox`. `NATURAL_API_BASE_URL`, when set, must match the exact sandbox origin. Configuration helpers are pure and perform no I/O.
- `getOwnParty` and `getAgent` verify resource identity/ownership; they **do not attest which agent a supplied key belongs to**. Public API has no credential-self endpoint. Deployment must independently verify key/agent pairing through controlled provisioning or an operator. Money responses check the configured initiator/sender agent; their supported scope is requests/payments created through this Tallie agent, not arbitrary third-party requests.

Do not put keys or these configuration objects in browser responses or logs. Clients use private fields and transport errors never include credentials, response bodies, provider error causes, request URLs, or customer details.

## Caller responsibilities

Persist an operation, immutable input, actor, instance ID and idempotency key **before** a mutation. Use an operation lease and retain the same binding across any deliberate retry. Never automatically replace an uncertain operation. Errors expose:

- `not_submitted`: this attempt did not submit a mutation (input/config/read/preflight failure).
- `rejected`: a mutation returned a narrowly classified definitive HTTP rejection.
- `unknown`: a mutation may have executed (network/timeout, 409/429/5xx, malformed or mismatched response, etc.). Reconcile before doing anything else.

These labels describe this transport attempt; a failed preflight cannot erase an earlier attempt's uncertainty. This package does not grant user consent, enforce an operation journal, check delegation permissions or fees, or implement payment reconciliation. The application service owns those controls. Null wallet balance/fee stays unknown, never zero. Amounts are positive safe-integer USD cents. Fee amounts follow the reviewed schema's positive-or-null contract.

Mutation preflights read the expected wallet/request and exact source ownership; they do not select a mutable default source. A fulfillment body never overrides the provider request amount. Response binding checks exact parties, amount, currency, request and originating agent. A create-request response has **no wallet relationship** in the reviewed contract: persist its acknowledgment ID and then read canonical detail before confirming the receiving wallet. Cancellation returns canonical status without inventing success in a fulfill/cancel race.

## Sandbox customer setup

`createSandboxInvitation` calls `/simulations/invite-customer`, sets `type: PERSON`, includes one explicit agent and permissions, and uses the supplied stable operation headers. It creates a synthetic identity, not a real phone/email invitation. `acceptSandboxInvitation` binds the returned invitation to its exact test customer and agent. The caller must verify the resulting active customer delegation and agent permissions before permitting further use. This is not evidence that a real consumer's KYC or financial onboarding is approved.

Wallet listing returns `{wallets, hasMore, nextCursor}`. The public wallet-list schema has no cursor parameter; callers must treat `hasMore` as incomplete instead of silently claiming a complete balance/source list. External accounts have documented cursor/limit pagination.

## Verification

```sh
npx tsc --noEmit -p packages/natural/tsconfig.json
npx vitest run packages/natural/src/client.test.ts
```

Fetch is injectable for tests; the production transport still pins the origin, refuses redirects, enforces a deadline across fetching/reading, bounds actual response bytes, validates parsed output, and makes one attempt. No authenticated provider call is made by these tests.
