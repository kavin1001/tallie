# Payment operations and production setup

Updated September 26, 2026. Implemented locally; not deployed. Natural P2P approval is founder-confirmed. The founder reports production setup is still needed. Local testing and explicit release approval remain required before pushing or deploying Natural changes.

## What is implemented

- **Sandbox lifecycle:** migrations017–019 enqueue saved sends/deposits in the same transaction as journal changes, backfill existing operations, claim bounded jobs with fenced leases, and apply canonical provider reads independently of browser polling. Matching requires the saved operation, customer, recipient, wallet/amount where applicable, agent and environment. There are no send/fund methods on the worker gateway.
- **Events:** `POST /api/webhooks/natural/sandbox` and `/production` verify Standard Webhooks signatures over exact bytes with a five-minute replay window. Current/previous rotation secrets are separate per environment. Bounded encrypted payloads are retained for 30 days; stable event IDs and hashes remain for deduplication. A database commit precedes acknowledgement. Conflicting event bodies are quarantined. Events wake canonical reads; they do not overwrite financial status.
- **Production connection:** migration020 saves one invitation operation per account before contacting Natural. The verified phone comes from the encrypted account binding. Recent passkey assurance and an enrolled credential are required. Natural hosts identity/account setup; Tallie stores no KYC fields. The saved invitation URL is encrypted and the return token is hashed. Repeated starts return saved state. An ambiguous invitation is not automatically replayed because the endpoint does not document idempotency guarantees.
- **Accepted invitations:** only `agent_delegation_invitation.accepted` is processed in production. The worker re-fetches the canonical event and current customer/agent grant, validates the exact original invitation and configured platform, then verifies the selected active standard agent-default customer wallet. All other production financial events remain quarantined in this release. A browser redirect only validates navigation state and never activates an account.
- **Operations:** an operator can pause new sandbox submissions while canonical reads continue. A previously admitted in-flight call may finish. Missing controls fail closed. This release cannot resume production financial execution. Worker health, unresolved jobs and event quarantine are available through a private CLI.

These are implemented safety boundaries, not evidence of a working live-money launch. Live bank funding/cash-out, production share debits, production financial reconciliation, device tests, support and hosted operations remain unfinished.

## Local sandbox maintenance

Apply migrations to the intended local database before starting a worker. Verify the target without printing its connection string. The supplied launcher isolates secrets by role.

```sh
npm run db:migrate
NATURAL_RECONCILIATION_ENABLED=true npm run worker
npm run payments:ops -- status --environment=sandbox
npm run payments:ops -- pause --environment=sandbox
npm run payments:ops -- resume --environment=sandbox
```

The worker receives the sandbox agent credential, agent/platform IDs and environment. It does not receive the provisioning key, identity encryption key, receipt/phone credentials or webhook signing secret for sandbox reconciliation. The gateway exposes only reads, but the provider agent key is not an independently restricted read-only credential; protect the process/host accordingly. Database runtime roles still share application authority and require production hardening.

`status` emits aggregate counts, freshness and a nonzero exit code for an unhealthy worker, unresolved/overdue work, or quarantined events. It does not print phone numbers, provider payloads or keys. It is a building block for monitoring; no external alert destination has been configured. Production heartbeats currently describe connection acceptance processing, not a live payment execution service.

## Reconciliation behavior

Unknown sends are searched by their saved operation tag in bounded pages. An exhausted search never proves that a payment did not happen. Pending operations use backoff; provider read failures retain the journal and slow retries. Unknown deposits lacking a canonical transfer ID require investigation and are not replayed by the worker. A verified webhook can wake a dormant job.

Completed sandbox payments are checked every 15 minutes for the first day, then every six hours up to 60 days. Afterward background polling pauses, while authenticated event hints can still wake checks. **Sixty days is a cost policy, not financial finality or a claim about the maximum return period.** Canonical returned/failed states cannot regress to paid through stale observations. No operator should clear an uncertain journal or invent a replacement operation to remove an alert.

## Production account setup inputs

Keep the existing sandbox variables unchanged. Populate separate server-side values from the same production Natural platform:

| Setting                                  | Where it comes from                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NATURAL_PRODUCTION_API_KEY`             | Production platform/party key. September 26 authenticated GETs succeeded for the active platform, agent list and webhook list; write scopes remain untested. |
| `NATURAL_PRODUCTION_AGENT_KEY`           | Production agent key (`ak_ntl_prod_…`), issued for the intended agent. Keep non-secret issuance evidence tying it to that exact agent.                   |
| `NATURAL_PRODUCTION_AGENT_ID`            | The production agent (`agt_…`) owned by the platform.                                                                                                    |
| `NATURAL_PRODUCTION_PLATFORM_PARTY_ID`   | Owning production platform (`pty_…`). Read-only party/agent checks verify ownership; `/parties/me` alone cannot establish which agent a key is bound to. |
| `APP_ORIGIN`                             | Exact stable public HTTPS app origin. Return navigation uses `/payments/connect/return`.                                                                 |
| `NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR` | Explicit per-transaction delegation ceiling in USD cents, 1–10000. This is a permission ceiling, not authorization to send.                              |
| `NATURAL_PRODUCTION_WEBHOOK_SECRET`      | Signing secret for the registered production callback `/api/webhooks/natural/production`; never reuse sandbox's secret.                                  |
| `NATURAL_PRODUCTION_CONNECT_ENABLED`     | Keep `false` until production configuration and the intended cohort/setup are ready.                                                                     |
| `NATURAL_PRODUCTION_WEBHOOK_ENABLED`     | Keep `false` until the provider endpoint/secret and worker have been configured.                                                                         |

Set `APP_MODE=beta`; production connection rejects preview/phone-demo configuration. Web needs the independent identity encryption secret to recover a saved invitation. The acceptance worker needs provider read access but does not receive signing/encryption secrets. Credential syntax checks are not authentication evidence. Neither flag enables live debits.

The gated web card starts setup, returns the same unexpired hosted invitation after interruption, and shows pending/connected/attention states. Return navigation preserves sign-in and validates its account-bound token. Expired or unknown invitations need an audited support recovery path; this release deliberately does not create an unverified replacement.

### Current setup and remaining device actions — September 26

The production platform key and dedicated Tallie agent key are configured and authenticated. The owner/platform is ACTIVE, and the dashboard issuance plus canonical key inventory establish the agent association. Agent-key creation requires a user session: the party API-key attempt was rejected403 before the key was successfully created in the dashboard. [Natural agent-key contract](https://docs.natural.com/guides/concepts/agent-keys).

The dedicated agent's owner-account limits are $10/transaction, $50/day and $100/month. Connected-customer permissions/limits are separate; current hosted invitations request a $10 transaction ceiling. No production financial execution is implemented by these settings.

An isolated [local HTTPS connection runtime](local-production-connect.md) is running on loopback port 3003 with a separate database, identity/session secrets, required passkeys and disabled phone demo. The temporary tunnel address is stored in ignored configuration. The production webhook is registered and `ENABLED` for only `agent_delegation_invitation.accepted`, with `sources: ["own", "connected"]`. Its once-shown signing secret was saved directly in ignored owner-only configuration. The existing Render phone demo is unchanged.

**Observed checks:** production agent authentication and platform/key binding; canonical webhook URL/events/sources/status; healthy connection-worker heartbeat; HTTPS runtime200 and anonymous connection 401; unsigned/tampered callback 401; correctly signed synthetic invalid envelope400. That last probe establishes receiver signature configuration without fabricating an accepted event or writing inbox data. Actual Natural delivery and customer acceptance remain unobserved.

**Next device steps:**

1. Open the current HTTPS test origin and complete phone proof and passkey enrollment. Use a consenting customer distinct from the platform-owner party; the app's customer connection must not resolve to its own platform identity.
2. Start Natural account setup from Tallie and complete the provider-owned identity/authorization flow. Observe accepted callback delivery, duplicate handling and canonical invitation/customer/grant/wallet binding. A redirect alone does not establish connection success.
3. Complete customer-owned bank linking in Natural, then read masked bank metadata through the accepted connection. Customer identity checks and bank login require the account holder; no credentials or documents belong in this repository.
4. Before stopping/changing the tunnel, disable its provider webhook and verify the canonical state. Temporary-origin passkeys do not migrate to a new hostname. Preserve the private operation journal/database/secrets for continuation.

No real money moved in setup. Local implementation verification is **773 tests / 44 files** plus formatting, all-workspace TypeScript and optimized build. Production funding/payment/cash-out and real event delivery remain separate gates.

### Bank flow: public contract versus observed behavior

The official schema recheck passed **18/18 assertions**, with unchanged SHA-256 `ca3882d75a009fcdcffecd1736237a6ccc9fb29113145df345c539b0fa63c32e`. This is public-contract evidence, not bank behavior.

| Step | Documented path | Still to verify for Tallie |
| --- | --- | --- |
| Bank linking | Customers link their bank in their own Natural dashboard; customer external-account reads are available. | A supported hosted return path or embedded bank-link experience; linking is not proven to be part of Connect acceptance. |
| Wallet funding | `POST /transfers/deposit`, with a verified active linked bank, customer/wallet context and at least $1. Settlement and available funds are asynchronous. | Customer grants, actual bank debit, holds, limits, fees, failure and return behavior. |
| Bank-funded repayment | `POST /payment-requests/{id}/fulfill` with the payer's customer context and `paymentSource.type=external_account`; documented ACH settlement. | Program enablement, exact grants/debit consent, retries and reconciliation. Tallie's production implementation is unfinished. |
| Cash-out | `POST /transfers/withdraw` to the customer's linked bank; standard ACH, with faster methods subject to enablement. | Actual bank receipt, availability, fees and customer-specific eligibility. |

**Selected initial defaults (ADR-032):** Natural-hosted customer bank linking, standard ACH, fresh per-action source/destination/amount/fee/timing review, and no automatic topping up. Favor direct bank-funded request fulfillment where supported to avoid a separate preload, but this remains a documented option until exact grants and account-specific behavior are verified. No fee or settlement promise is inferred.

`NaturalProductionBankClient` now implements read-only customer bank discovery and selected-account rereads. `wallets.read` is documented for these reads and already present in current invitations. Output contains masked display fields; no bank passwords, account names, full account/routing numbers or provider metadata. The resource exposes no separate verified flag, so `connected` is display readiness only. The public invitation enum includes `wallets.deposit`/`wallets.withdraw`; the exact combinations for bank mutations are not yet established, and no speculative scopes were added.37 injected-response tests and independent review passed; no live customer-bank behavior is established by those tests.

The existing sandbox customer-funding simulation credits a synthetic wallet directly. The documented test-bank linking simulation operates on the calling party and has no customer parameter. Neither proves a connected-customer bank path. Ask Natural for the supported connected-customer bank fixture and failure/return controls, precise grants and debit-consent requirements, hosted bank-link/return options, and the approved program's fees/holds/limits. Then test that sandbox path and a small explicitly approved live amount through bank settlement and cash-out. Customers must complete their own Natural identity verification and bank login; no bank passwords or identity documents should enter this repository.

## Live verification still required

1. Verify production credentials and exact agent-key issuance; observe a real targeted-phone invitation, KYC/acceptance, selected wallet and interruption/reload. Verify a forwarded invitation cannot bind the wrong person. Public docs alone do not establish that last behavior.
2. Observe the supported bank path: account linking, eligibility/verification, fees, available funds vs holds, funding failure/return, and cash-out. The documented bank-funded request fulfillment path differs from a direct wallet transfer; do not silently substitute one for the other.
3. Implement production share consent, debit dispatch and late-event reconciliation against the agreed funding path, with recent strong authentication, limits and immutable operation identity. The sandbox projection is not the production ledger.
4. Verify two consenting people on devices, production-origin passkeys/recovery, callback signatures/retries and crash recovery. Production acceptance tests currently inject provider responses.
5. Provision always-on workers, private storage, backed-up PostgreSQL with a restore test, restricted runtime database roles, alerts and support. Keep the total recurring plan within $100 including provider subscriptions/usage. No paid resources were changed here.
6. Founder locally tests the reviewable release and explicitly approves push/deployment.

## Offline release assessment

```sh
npm run payments:readiness
npm run payments:readiness -- --template
npm run payments:readiness -- --evidence /private/path/payment-release-evidence.json
```

The default returns `blocked`. The versioned template contains only boolean evidence and numeric budget allowances; it must not contain credentials or customer records. A declaration is not verification: the CLI cannot validate a restore, price, device test or provider binding. Implementation gates are compiled into the report and cannot be bypassed with environment flags or a fully checked template. It never enables payments.

## Primary contracts reviewed

- [Natural webhook verification](https://docs.natural.com/guides/webhooks/receive-events) and [event catalog](https://docs.natural.com/api-reference/event-catalog).
- [Production customer invitations](https://docs.natural.com/guides/connect/invite-customer): hosted verification/authorization differs from sandbox simulation.
- [Canonical transfer read](https://docs.natural.com/api-reference/transfers/get-transfer): checked in sandbox against an existing deposit with zero provider mutations.
- [External accounts](https://docs.natural.com/guides/concepts/external-accounts), [deposit and withdrawal](https://docs.natural.com/guides/transfers/deposit-and-withdraw), and [request fulfillment](https://docs.natural.com/guides/payments/fulfill-or-decline-request): documented contracts, not Tallie production observations.
