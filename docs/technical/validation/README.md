# Payment design validation

**Purpose:** executable checks for selected architecture invariants before application code exists. These are design models and database experiments. They do **not** certify Natural, Venmo, Sendblue, production authorization, or a working product.

## Run

From the repository root:

```sh
python3 -m unittest discover -s docs/technical/validation -v
python3 docs/technical/validation/run_postgres_checks.py
```

The first command uses only the Python standard library. The second requires Docker and an **already-local** `postgres:17-alpine` image. It never pulls an image, publishes a port, mounts a user directory, or accesses another container. It starts its own random-name container with networking disabled and a temporary in-memory database directory, then removes that container in `finally`. `postgres-results.json` records the latest actual run. A failure is a nonzero exit; inspect the number of completed checks as well as the cleanup field.

`postgres_invariants.sql` is a deliberately small **validation-only schema**, not an application migration. In particular it has no production roles, permissions, tenancy/RLS, immutable-record triggers, financial-approval schema, event payload storage, or migrations. Those must be implemented and tested separately.

## Observed results

Verified during this design session:

- **18 model tests passed.** Bounded exploration visited **47 distinct states and 104 accepted transitions** at a maximum depth of nine. Rejected actions are the model's intentionally blocked actions. This is a finite reduced model, not an exhaustive proof of a future implementation.
- The deterministic cents model checked 301 totals for two weight patterns, across all participant-input permutations, plus the PRD's $117 example.
- **Seven PostgreSQL check groups passed** on PostgreSQL **17.11**, at **READ COMMITTED** isolation. A second transaction waited for an uncommitted guard and then failed the unique constraint; this was genuine contention between separate PostgreSQL sessions.
- Docker reported the owned container removed after testing. No preexisting container was modified.

The first PostgreSQL harness run exposed a readiness race: the Docker entrypoint's temporary initialization server passed `pg_isready`, then stopped. The harness now also waits for the final `postgres` process to become PID 1. The corrected run and the subsequent consent-replay check passed. This was a harness startup defect, not evidence of a payment-system defect.

| Check | What was exercised | What remains unproven |
|---|---|---|
| Single active guard | Real unique-index contention across different revisions, directions, and rails | Correct guard acquisition/release in application code |
| Guard retention | Unknown, held, processing, canceling, and externally reported states reject another active guard | Whether a provider terminal/canceled response is final and authoritative |
| Idempotency | Concurrent same-key/same-payload requests return one operation; changed payload rejected | Provider key retention and exact payload rules |
| Single consent | A different idempotency key cannot execute the same consent twice | Authentication strength and integrity of consent capture |
| Inbox and movements | Eight concurrent duplicate deliveries collapse; payer/requester events remain separate but map to one movement | Actual provider IDs, signature validation, and canonical resource lookup |
| Changed duplicate payload | Same verified envelope identity with different raw bytes is quarantined without replacing the original or processing another command | Production quarantine policy and provider payload stability contract |
| Reconciliation freshness | Old in-flight GET cannot replace a newer completion/return; latest local generation still rejects an incompatible stale provider snapshot | Actual provider version/timestamp semantics and implementation correctness |
| Transactional outbox | Operation and command roll back or commit together | Worker crash recovery, leases, and actual remote side effects |
| Money arithmetic and corrections | Exact integer conservation, stable rounding, return after refund, duplicate evidence | Full receipt extraction, tax interpretation, and all adjustment product states |
| External limitation | A stale Venmo link can produce a second transfer after Natural succeeds | Venmo deep-link compatibility or payment confirmation integration |

## Recommended schema invariants

1. **Stable share account.** An `expense_participant` has an immutable ID even before the invite is claimed. A `share_account` anchors that participant's financial history for one expense. Allocation versions and correction obligations refer to it. Claiming an invite updates an identity binding, not the rounding identity or financial account. Once resolved, prevent duplicate verified users within the same expense participant set. The original payer's own allocation never creates a payable request.
2. **Execution guard crosses revisions and directions.** Exactly one unreleased guard may exist per `share_account`. Do not include revision, amount, direction, request ID, rail, or status in its uniqueness key. A normal OPEN provider request owns this guard; fulfillment changes its phase under the same ownership. A repayment/refund direction does not escape the guard. A direct send or withdrawal without an expense has its own operation/consent guard.
3. **Unknown is a financial lock.** Submission possible, unknown result, provider hold, processing, requested cancellation, external handoff, and unresolved external report retain the guard. Lease expiry, job failure, approval expiry, a webhook timeout, or an HTTP error does not prove that money cannot move. Only an explicit domain transition with stored evidence releases it.
4. **One consent, one execution.** Store one immutable consent snapshot: actor, destination identity/provider party, amount, currency, funding source, obligation version, fees/timing where applicable, authorization time, expiry, and session/auth context. `UNIQUE(consent_id)` on the money execution protects direct sends and withdrawals as well as request fulfillment. A different idempotency key cannot replay an approval.
5. **Immutable operations and payload hashes.** Local operation IDs and provider idempotency keys survive process restarts. `(actor, operation_scope, client_key)` is unique, with a canonical payload hash. A duplicate with a different hash is a conflict, not a success returning an unrelated result. The provider key belongs to the immutable operation, not the queue attempt. One operation can have many transport attempts; a genuinely new financial attempt needs a new operation and new consent after the old outcome is conclusively known.
6. **Request consumption is permanent history.** A consumed Natural request is never repurposed for a different fulfillment attempt. Provider request uniqueness uses provider/environment/request ID. Recovery uses a new provider request only if provider rules permit it. Previous IDs and attempts stay traceable. Timeout alone is not permission to reissue.
7. **Inbox dedup and financial dedup differ.** Inbox identity includes provider, environment, account scope, and event ID. Canonical movement identity includes provider, environment, and actual payment/transfer ID. Connected payer and requester views may be two legitimate inbox records for one movement. Repeated same-envelope IDs with a different payload hash should be quarantined/alerted, not silently ignored. The SQL experiment tests uniqueness, not this complete handler.
8. **Append-only evidence, replaceable projections.** Keep original events, canonical snapshots, and signed journal entries. Compute the current view from accepted evidence. Do not assign statuses an unconditional numerical rank: a verified return legitimately follows completion. An old completion notification does not remove a verified return. Balance availability comes from the provider, not the obligation journal.
9. **Independent fanout operations.** A frozen expense publication creates all allocation rows and one stable command per eligible recipient in a local transaction. Each provider request is independent. Retry/reconcile only its operation. A successful Maya request cannot be rolled back by a Leo API timeout. Provider notification delivery is a separate command and cannot reexecute a payment operation.
10. **Atomic dispatch intent.** Reserve the gate, consume/bind consent, create the operation, and insert the outbox command in one transaction. The worker records that submission may occur before making the network call. After that point a crash is uncertain until reconciliation. An approval can expire safely before any possible submission; expiry never cancels an already-submitted transfer.
11. **Fence observation work.** Increment a per-resource reconciliation generation before issuing a network read; apply its result only if the generation remains current under the resource lock. Applying newer authoritative evidence invalidates old in-flight reads. A generation fences local concurrency; it cannot prove that the provider served fresh data. Independently validate source versions and permitted transitions, and reconcile incompatible observations without regressing state, releasing a lane, or journaling a duplicate effect.

Money remains integer cents. Stable ordering for rounding must use the immutable participant ID; display-name sorting or replacing an invitation ID with a user ID can move a cent after publication.

## Correction and return accounting

For each share account within **one expense**, let:

- `A` = the current approved target allocation for that participant.
- `C` = net confirmed transfers from that participant to the original payer. Collections are positive, repayments to the participant are negative. Verified returns reverse the original transfer. Confirmed external payments have explicit manual provenance.
- `R = A - C` = the remaining economic amount for review.

`R > 0` means a proposed collection; `R < 0` means a proposed repayment. This equation never grants authority to charge, proves bank availability, or offsets unrelated expenses. Pending amounts are not confirmed credits and retain the execution guard.

Example: original share $50, corrected target $30, $50 payment completed, $20 repayment completed. Net collected is $30 and residual is zero. If the original $50 later returns, net collected becomes **minus $20** and the residual becomes **$50**. A simplistic “reopen the $30 request” loses $20; “ignore returns on settled shares” loses $50. Preserve every movement, raise a reconciliation issue, resolve any still-active adjustment, and require fresh explicit consent for any further collection.

An implementation can use original and adjustment obligations, but the residual identity must reconcile across them. Otherwise original-obligation recovery plus an independently open adjustment can collect the same money twice. An invariant job should compare the aggregate proposed/outstanding adjustments with this account-level evidence, including overpayment and return cases.

### Publishing a correction

Prepare a candidate immutable revision and show each participant's differences. Lock affected share accounts in a stable order in the local transaction; never hold a database transaction open during a network call. Reserve a correction saga, request cancellation of affected OPEN provider requests, and wait for confirmed outcomes. Only after affected old requests are safely nonpayable and no execution is unresolved should the new allocation snapshot become effective atomically in the local database and new per-person commands be queued.

If a hosted payment wins a cancellation race, rebase or pause the correction and preserve the actual transfer. Some successful remote cancellations may already exist; show that partial result and recover forward. Do not claim that all remote actions rolled back. Do not publish a new total while leaving old higher requests silently payable. Settled payment records remain immutable; revised target allocations produce explicit proposed differences.

## External handoff boundary

The model requires a confirmed provider cancellation before exporting a Venmo link when a Natural request exists. Reserving `canceling` alone is insufficient: a provider-hosted payment can win the race. An unverified guest cannot cancel an existing request; authenticated payer verification and request-scoped authorization remain application requirements.

The app can serialize paths it controls. It cannot revoke an already-exported Venmo link or prevent the user paying independently. After the user reports no payment and returns to Natural, the old Venmo link can still be used. The included test intentionally records both payments and detects an overpayment. It does not claim cross-provider exactly-once settlement. Never silently erase the second movement or automatically refund it.

## Follow-up verification required during implementation

- Provider sandbox: cancellation versus fulfillment contention; request single-use semantics; late returns; holds; timeouts before and after remote acceptance; resource lookup after a lost response; documented idempotency retention.
- Worker crash points: before dispatch marker, after marker/before HTTP, after HTTP/before response write, after response/before notification. Expired leases must not create a fresh money command.
- Postgres integration: real migrations/roles, authorization, serializable anomalies where applicable, sorted multi-share locking/deadlock recovery, transaction retries, foreign keys, row immutability, and inbox payload conflicts.
- Natural fulfillment and source/destination binding; actual connected-account event IDs and webhook ordering.
- Guest identity and invite-claim races, duplicate participants, blocked relationships during delayed activation, and late signup after external settlement.
- Real iPhone Venmo behavior and cancellation/return states. No payment was executed by these checks.

Keep the reduced model aligned with accepted ADRs. Replace or supplement it with tests against the actual implementation when the domain engine exists. Passing this folder is evidence for a limited set of design choices, never a release gate on its own.
