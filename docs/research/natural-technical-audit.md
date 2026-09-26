# Natural technical contract audit

**Reviewed:** 2026-09-25. **Scope:** public documentation and downloaded OpenAPI, read-only. No authenticated sandbox or production call was made. Public contract assertions passed; this is not evidence of runtime compatibility, consumer-program eligibility, or actual settlement.

## Evidence and confidence

The current [OpenAPI](https://docs.natural.com/api-reference/openapi.json) reports OpenAPI 3.1.1. The downloaded bytes had SHA-256 `ca3882d75a009fcdcffecd1736237a6ccc9fb29113145df345c539b0fa63c32e`. Eighteen read-only assertions checked request actor/source fields, positive integer amounts, immutable fulfillment amount, request/payment/connection states, required idempotency headers, connected-event configuration, event-history filtering, missing unsupported source/filter fields, and REST version/timestamp fields. All passed. Reproduce with the [contract checker](../technical/verification/check_natural_contract.py); the [recorded result](../technical/verification/natural-contract-results.json) includes the hash and timestamp. Record a fresh schema hash and repeat contract checks when implementation starts; docs can change.

**Confidence labels used here:** “documented” means primary public sources; “design” means our recommended implementation; “unverified” means sandbox evidence or provider confirmation is still required.

## 1. Identity and credential boundary

**Documented.** A customer is a Natural party, `pty_*`; the customer response has a parent delegation `dlg_*` and associated agents `agt_*`. Customer delegation states include `ACTIVE`, `SUSPENDED`, `REVOKED`, and `EXPIRED`. Reads pass `customerPartyId` in the query; money mutations pass it inside `data.attributes`. Omitting it can act as the platform's party. Explicitly select the consumer actor on every supported call. [Customer context](https://docs.natural.com/guides/connect/move-money-for-customer), [customer schema](https://docs.natural.com/api-reference/customers/get-customer).

An agent key binds a specific agent. A party API key acts as the party, without agent attribution. Agent keys have a fixed credential policy; customer delegations constrain what that agent may do for a customer. Agent money commands require `X-Instance-ID` even though its OpenAPI header is marked optional for the endpoint as a whole. Missing it is documented as `400 missing_instance_id`. Use an opaque operation/run ID, stable across retries. Provisioning and webhook administration use separately held administrative credentials. [Authentication](https://docs.natural.com/api-reference/authentication).

**Design.** Never accept a Natural actor, wallet, or external-account ID directly as an authorized browser choice. Resolve an app-owned source handle against the authenticated user's current connection. After every response, verify expected actor, recipient, amount, currency, and linked request before adopting it. Keep a platform-actor deny rule in the P2P adapter; a missing customer ID must fail locally.

### Connect account binding

Targeted invitations support a phone/email recipient, agents and permissions, and `redirectUrl`; acceptance records the connected customer. Shareable invitations can admit multiple customers. A redirect is navigation, not proof of connection. The targeted invitation ID plus its authenticated acceptance resource is the strongest documented correlation path for a specific app user. Use a server-owned onboarding session and nonce in the return URL, then fetch the accepted invitation/customer. Never attach an arbitrary newly listed customer to the most recently active signup. Reaccepting an old offer does not enlarge permissions. [Invite customer](https://docs.natural.com/guides/connect/invite-customer).

**Unverified:** exact minimal permission set, invitation delivery behavior, consumer KYC eligibility, how an invitation's accepted financial identity is tied to our verified phone identity, and whether the desired onboarding presentation can be embedded. Test interrupted signup, shared/forwarded invitation, accepted invitation in the wrong app session, revoked access, and reconnect with a fresh offer.

## 2. Concrete payment contract

The following are **schema-compatible request-body illustrations**, not executed examples. Abbreviated IDs are explanatory placeholders; real IDs must meet the provider's format. Use the pinned official TypeScript SDK behind an adapter, checking its serialized wire behavior against these contracts.

### Create one request for one share

`POST /payment-requests` requires `Idempotency-Key`. Use the requester's customer party and receiving wallet; use the payer's confirmed party identity. Amount is positive integer cents and description is at most 80 characters. [Create request](https://docs.natural.com/api-reference/payment-requests/create-payment-request).

```json
{
  "data": {
    "attributes": {
      "customerPartyId": "pty_REQUESTER",
      "walletId": "wal_REQUESTER",
      "amount": 2600,
      "currency": "USD",
      "payer": { "type": "party_id", "value": "pty_PAYER" },
      "description": "Dinner",
      "tags": { "app_operation_id": "OPAQUE_CREATE_ID" }
    }
  }
}
```

Creation can trigger Natural notifications. No reviewed create-schema field suppresses them. Create only once both enrollment and the approved notification policy permit it. [Request delivery](https://docs.natural.com/guides/payments/request-payment).

### Fulfill that request

`POST /payment-requests/{id}/fulfill` uses the **payer's** customer party. The amount comes from the request; it cannot be overridden in the fulfillment body. `paymentSource` supports wallet or verified linked bank. Bank repayment settles asynchronously over ACH. The response is a `payment` (`pay_*`), which may be processing or held. One request accepts one attempt. Retries of the same attempt reuse the key. Native decline cannot act on behalf of a customer. [Fulfillment guide](https://docs.natural.com/guides/payments/fulfill-or-decline-request).

```json
{
  "data": {
    "attributes": {
      "customerPartyId": "pty_PAYER",
      "paymentSource": {
        "type": "external_account",
        "externalAccountId": "eac_PAYER"
      },
      "tags": { "app_operation_id": "OPAQUE_FULFILL_ID" }
    }
  }
}
```

A wallet source is `{ "type": "wallet", "walletId": "wal_PAYER" }`. Always supply the exact source the user approved; allowing a mutable provider default to choose a different wallet would weaken consent binding.

### Cancel before revising or switching to Venmo

`POST /payment-requests/{id}/cancel` accepts `data.attributes.customerPartyId` for the **requester**. It cancels an open outgoing request. Treat an app cancellation command as pending until canonical provider state confirms cancellation. [Cancel request](https://docs.natural.com/api-reference/payment-requests/cancel-payment-request).

### Direct send

`POST /payments` has amount, currency, `customerPartyId`, `walletId`, and counterparty; no documented bank-source field. Use an enrolled recipient's `party_id`. Direct wallet payments cannot be canceled; only eligible unclaimed claim payments have a cancellation path. [Payment schema](https://docs.natural.com/api-reference/payments/create-payment), [payment lifecycle](https://docs.natural.com/guides/concepts/payments).

**Unverified:** new-request recovery after a failed/returned fulfillment, partial/late bank events, funding permission behavior, and fees/quotes before user approval. Never infer that an existing request may be fulfilled again because the previous payment failed.

## 3. States, fees, and available balances

Documented request states: `OPEN`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETURNED`, `CANCELED`, `DECLINED`, `EXPIRED`. `payerCanPay` only means open/unexpired/no attempt; it does not validate funding or authorization. Request and payment are separate resources. [Request lifecycle](https://docs.natural.com/guides/concepts/payment-requests), [get request](https://docs.natural.com/api-reference/payment-requests/get-payment-request).

Payment states: `CREATED`, `PROCESSING`, `PENDING_CLAIM`, `IN_REVIEW`, `COMPLETED`, `FAILED`, `RETURNED`, `APPROVAL_DENIED`, `CANCELED`. Completion can be followed by a legitimate return. Do not build a generic state rank that refuses all post-completion changes. Holds require their own resolution; our approval is not the provider's approval. [Get payment](https://docs.natural.com/api-reference/payments/get-payment), [approvals](https://docs.natural.com/guides/concepts/approvals).

Wallet responses distinguish `balance.available` and `balance.total`; either the balance object itself may be unavailable. Do not fabricate zero balances for missing data or derive spendable funds from obligations. [Wallet schema](https://docs.natural.com/api-reference/wallets/get-wallet).

The catalog says request fees may be null until completion and incoming-request events omit them. A null fee is therefore not a zero-fee quote. Fix consumer program pricing or obtain a supported preapproval quote before promising exact total debit/net receipt. [Event catalog](https://docs.natural.com/api-reference/event-catalog).

## 4. Retry and deduplication policy

**Documented.** Idempotency is scoped to the acting party. Keys bind the original payload; changed payload and still-running originals both produce `409 conflict`. Terminal failures are replayed as well as success. Records expire 48 hours after terminal outcome; running records remain reserved. Certain transient errors are not recorded. A same-key retry after expiry can execute a new operation. [Idempotency](https://docs.natural.com/api-reference/idempotency).

**Design.** Persist an operation and immutable serialized payload/hash before dispatch. Store actor, environment, endpoint, key, instance ID, first-submission time, consent reference, and provider IDs. Provider SDK auto-retries must preserve these values. A worker lease prevents simultaneous dispatch; local operation uniqueness persists longer than provider retention. After timeout, keep `UNKNOWN` and reconcile. Do not create another operation to make a spinner disappear.

If terminal timing is unknown, stop automatic mutation retries conservatively before 48 hours from the first submission. An unresolved operation then needs positive provider evidence or support. This is intentionally more conservative than the provider's retention rule. Local uniqueness alone cannot make an expired provider key safe.

The reviewed payment-list endpoint supports customer, cursor, and limit; it has no server-side tags/idempotency-key filter. Recovery may scan paginated resources for our opaque metadata. A failed or incomplete scan is not evidence of absence. Preserve unresolved guards while escalating. [List payments](https://docs.natural.com/api-reference/payments/list-payments).

## 5. Webhook receipt and reconciliation

**Documented.** Natural uses Standard Webhooks: `webhook-id`, `webhook-timestamp`, and `webhook-signature`, verified over raw request bytes. Rotation permits overlapping signatures. Subscribe to `sources: ["own", "connected"]`; the default is own only. Connected delivery depends on active authorization. Automatic deliveries have seven total attempts; repeated event failures can disable the endpoint. A successful HTTP response acknowledges delivery. [Receive events](https://docs.natural.com/guides/webhooks/receive-events).

**Design.** Verify first, insert the complete event into a durable inbox transaction, then respond 2xx. Process asynchronously from that inbox. The documentation's fire-and-forget handler is illustrative and must not be copied into a crash-safe application. Invalid signatures fail closed. A valid but unknown event type is stored and quarantined/alerted without blocking unrelated supported types.

There are two schemas to normalize:

- REST: JSON resource wrapper, `attributes.amount` integer, upper-case public statuses, typed relationships.
- Webhook: `data.object`, `amount.minorUnits` as a string, lower-case statuses/currency in catalog examples, and an object `version`.

Sender and recipient may receive different event IDs for the same payment. Deduplicate ingestion by environment/provider/event ID; serialize the financial aggregate by canonical payment ID and idempotently apply journal transitions. Keep each actor view's visibility separate. A recipient snapshot must not overwrite richer sender-only fields with nulls. `payment_request.returned` and `payment_request.failed` are absent from the reviewed event catalog; use payment events and resource reconciliation for these outcomes. [Event catalog](https://docs.natural.com/api-reference/event-catalog).

**Design.** Re-fetch canonical provider resources when an event affects money, has a stale/unknown version, conflicts with current state, or represents an incomplete actor view. Never assume event arrival order is settlement order. Reconcile all open, held, processing, unknown, and recently completed return-capable payments on a schedule even when webhooks appear healthy.

Event history supports `customerPartyId` but requires `eventType` when reading another party; use separate customer/type watermarks, overlapping windows, cursor exhaustion, and event-ID dedupe. Access after revocation is limited; a new delegation does not reopen all old redelivery rights. Retain prior received evidence and escalate unresolved money rather than inventing a result. [Event retrieval](https://docs.natural.com/api-reference/events/list-events), [delivery and recovery](https://docs.natural.com/guides/webhooks/receive-events).

## 6. Recommended financial invariants

These are our design requirements, not additional claims about Natural:

1. Every effect has one stable local operation ID and immutable actor/payload/approval references.
2. An obligation has one active rail reservation across every expense revision. Unknown/held/processing outcomes retain that reservation.
3. The original request must be conclusively canceled before revision replacement or an external handoff. A returned payment is a new adjustment event, never deletion of history.
4. No LLM output, phone address, reaction, preview GET, redirect, or webhook alone grants payment authority.
5. Every authorized payment binds exact payer, payee, currency, amount, request revision, source, fee policy, and expiry.
6. Provider identities are server-resolved and matched before and after execution. Missing customer context fails locally.
7. Sender and recipient event views can produce only one settlement entry for the canonical payment transition.
8. Completed payments remain immutable facts; later returns add compensating facts and explicitly reopen obligations only according to the approved recovery policy.
9. Notification delivery never triggers re-execution of a successful financial operation.
10. External Venmo confirmation is manual evidence with its own label. No system can guarantee against a user paying an old external link again; prevent competing app execution and present unresolved handoffs honestly.

## 7. Integration gates before live money

| Gate | Required evidence |
|---|---|
| Consumer Connect use case | Written program acceptance, permissions, KYC, fee and return responsibilities |
| Identity binding | Accepted targeted invitation links to the intended verified app user; wrong-user/forwarded-return tests fail safely |
| Payer funding | Sandbox wallet and verified-bank fulfillment; ownership failures and insufficient funds tested |
| Request recovery | Provider-confirmed one-attempt failure behavior and safe new-request procedure |
| Cancellation races | Fulfill versus cancel/revision/Venmo observed in sandbox; held/unknown outcomes block replacement |
| Event authenticity | Raw-body verification, rotation, replay, both actor views, and no premature 2xx |
| Crash recovery | Worker crash before/after provider acceptance and lost response resume the same operation |
| Idempotency expiry | Unknown operation cannot be resubmitted after conservative cutoff without resolution |
| Fee disclosure | Fixed approved consumer fee schedule or supported preapproval quote |
| Revocation and outage | Access loss preserves unresolved money; event-history recovery and endpoint-disable alerts work |

Until these have evidence, mocks are useful for product work but live payment paths remain disabled.
