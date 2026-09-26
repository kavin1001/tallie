# Tallie data layer

This package backs the first usable **local, simulated** Tallie experience with PostgreSQL. Money never leaves the application. The simulator does not call Natural, Venmo, a bank, or a messaging provider.

## Run

From the repository root, with the local `.env` populated from `.env.example`:

```sh
npm run db:up
npm run db:migrate
npm run dev
```

`npm run dev` starts the web application and the separate simulator worker. To run only the worker:

```sh
npm run worker
```

`APP_MODE=demo` is required by the database accessor, API wrapper, and simulator worker. A different mode fails closed. Adding a live credential does not enable real payments.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| `contracts.ts` | JSON types; safe for frontend type-only imports; all money is a decimal integer-cent string |
| `schema.ts` | Kysely's typed PostgreSQL table mapping |
| `client.ts` | Bounded PostgreSQL connection pool and runtime mode gate |
| `migrate.ts` / `migrations/` | Ordered SQL migrations, SHA-256 content check, advisory migration lock, transactional application |
| `expense.ts` | Atomic expense/allocations/request publication in the caller's transaction |
| `seed.ts` | Synthetic, isolated workspace for each new browser demo session |
| `simulator.ts` | Idempotent local settlement and its activity events |
| `apps/web/src/server/` | Authorization, validation, review/consent commands, projections, HTTP security boundary |
| `apps/worker/src/index.ts` | Background worker; resumes queued operations after a restart |

Do not import this package's main entry into a client component. Use `import type` from `@tallie/db/contracts` for public transport types. Domain money calculations live separately in `@tallie/domain`.

## Session and workspace isolation

Starting the demo creates five synthetic people and a private set of expenses in a fresh workspace. It does not mutate a global shared fixture. A cryptographically random 32-byte token is sent in a host-only HttpOnly `SameSite=Strict` cookie; PostgreSQL stores its SHA-256 hash. HTTPS configuration adds `Secure`. Sessions expire after seven days.

Demo persona switching stays inside the current workspace, revokes the old session, and rotates the token. Every financial command locks and rechecks the session before other mutations. Reviews bind to a specific session, so switching away and back cannot replay an earlier review.

This is an explicit **demo identity adapter**. It does not verify real people, phone possession, financial ownership, or passkeys. It must not be repurposed as production authentication. Real authentication, recovery assurance, guest invitations, and Natural onboarding remain separate implementation gates in the technical design.

## Durable commands

### Publishing a split

1. The API validates strict JSON and an explicit split method.
2. A short transaction locks the current session and the idempotency identity.
3. Pure domain code calculates exact integer-cent allocations.
4. PostgreSQL receives the expense, every allocation, publication finalization, each nonzero non-self request, and activity.
5. A deferred constraint verifies the total and original payer's membership at commit.

The expense's financial data and participant set become immutable after finalization. Later zero-share inserts cannot widen receipt access. Expense corrections are not implemented yet; they will require immutable new revisions and the staged cancellation/reconciliation protocol in the living technical design.

### Approving a payment

1. An authenticated payer requests an immutable review built from server-owned data.
2. The review includes the exact payer, recipient, amount, source, zero-fee **simulation** policy, request version, session, and five-minute expiry.
3. The explicit approval submits the review digest and a stable idempotency key.
4. The transaction rechecks session, expiry, digest, current request version, and request eligibility.
5. The transaction stores a unique consent, reserves the request as processing, and inserts a durable simulator operation before returning `202`.

Retries with the same key and identical command return the same operation. A changed command returns `409`. A review cannot issue a second consent with a new retry key. Multiple fresh reviews cannot reserve the same request simultaneously. Direct sends use the same immutable review/consent mechanism, and an exact existing request match requires the user to open that split.

### Completing a simulated payment

The worker polls for due operations, normally every 500 milliseconds. Operations become eligible 1.5 seconds after approval to make the processing state observable. `FOR UPDATE SKIP LOCKED` allows concurrent worker processes. For this **local simulator only**, completion, a unique settlement effect, request status, and two participant activity records commit in one transaction. A crash before commit changes nothing; a retry is safe.

A real payment call cannot share this local atomicity. The Natural adapter must implement persisted dispatch identity, provider idempotency, uncertain outcomes, inbox/outbox processing, and reconciliation before it can replace this simulator. The current worker does not pretend to implement those network guarantees.

## Database checks

- UUID workspace scoping with composite foreign keys prevents cross-workspace object references.
- Integer `bigint` cents avoid floating-point arithmetic.
- Amounts are bounded to $100,000 in this demo; that is an app limit, not a provider limit.
- Deferred conservation includes the original payer and rejects partial publication.
- Published expenses, allocations, reviews, consents, settlements, activity, and idempotency results are immutable.
- Request and operation financial tuples cannot change when their status changes.
- Requests point to their exact published allocation and original payer.
- Unique review/consent constraints and one-operation-per-request reservation defend against duplicate processing.
- Settlement amount must match its operation; operation identity permits one settlement effect.
- Same actor/scope/key idempotency is serialized even before its row exists.

The server checks participant access on expense reads and payer/payee access on operations. Dashboard reads use a repeatable-read transaction to keep cards, statuses, and totals consistent. Monetary summaries aggregate all matching records independently of the bounded visible lists. Zero-dollar non-payer shares are `no_payment`; they are not mislabeled as the original payer. Closed expenses containing a canceled share are `canceled`, not `settled`.

`Dashboard.personBalances` includes complete, separate owed/owing amounts for every other workspace person, including zero balances. `GET /api/expenses/:id` returns `ExpenseDetailData` (`expense` and `requests`) from one repeatable-read snapshot. Its request collection is complete for that expense but restricted to the current payer/payee; other participants can see allocated shares without seeing private issue notes or request actions.

## Verification

```sh
npx vitest run apps/web/src/server/commands.integration.test.ts apps/web/src/server/http.test.ts
npx tsc --noEmit -p packages/db/tsconfig.json
npx tsc --noEmit -p apps/worker/tsconfig.json
```

Integration tests create a randomly named `tallie_test_*` schema in the configured local PostgreSQL server, migrate it, exercise real SQL transactions and concurrent sessions, then drop that specific schema. Tests refuse a nonlocal database host. They never truncate the development schema.

Coverage includes concurrent duplicate publication, repeat approval, competing reviews, worker transaction rollback, multiple workers, cancellation racing approval, workspace and participant isolation, persona rotation, immutable tuples, zero shares, and conservation. The HTTP tests cover exact Origin checks, strict JSON, bounded actual request bodies, no-cache responses, canonical cents, cookies, and the demo mode gate. `scripts/verify-api.ts` separately exercises the running HTTP server and worker.

These are **implementation tests against local PostgreSQL and local HTTP**, not evidence about provider sandbox or live financial behavior.

## Current limitations

- The local development database user owns migrations and runtime tables. Production role separation, migration-owner isolation, RLS or equivalent restricted functions, and the receipt-worker role matrix are not implemented.
- No bank balance is tracked or invented. `Demo balance` labels the simulator source, and local settlement events are synthetic evidence only.
- Natural, iMessage, receipt upload/AI extraction, and Venmo capabilities are explicitly false. No consent or payment confirmation is inferred from an external link.
- The current API uses internal `/api` routes; versioned `/v1` external contracts are a future integration milestone.
- There are no returns, immutable correction revisions, deposits, withdrawals, persistent groups, debt netting, or production provider webhooks yet.
- Demo lists are bounded to 100 expenses, 200 requests, and 100 activity records; complete pagination is not implemented. Monetary summary queries do not share those caps.
- API rate limits, public-demo abuse controls, automatic expired-workspace cleanup, production logging/alerting, backup/restore drills, and audit repair tools remain future work. Keep this build local or behind access control.
- HTTPS, production auth, key management, and compliance/provider acceptance are prerequisites to handling real identities or money.

Never edit an applied SQL migration. Add a new numbered migration and rerun the checks. The migration runner rejects content drift rather than silently accepting it.
