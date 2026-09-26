# Tallie implementation verification

**Date:** September 25, 2026  
**Evidence level:** Actual local implementation, synthetic people/receipts, simulated payments. No provider sandbox or live-money claim.

## Environment

- Node.js 24.11.1, npm 11.6.2; Next.js 16.3.6, React 19.3.0, Kysely 0.29.6.
- Dedicated PostgreSQL 17 container on localhost:55434, isolated from other workspace projects.
- Web server and durable simulator worker run as separate processes. `npm run start` serves the production build locally; `npm run dev` starts both in development.
- Fresh Tallie database migrations succeeded. Root README and `npm run setup` document repeatable startup. No external credentials are needed for this slice.

## Commands and results

| Check | Result | Scope |
|---|---|---|
| `npm run format:check` | Passed | Application, packages, scripts, configuration and CI files |
| `npm run typecheck` | Passed | Strict web/domain/database/worker/script TypeScript, including unused-code checks |
| `npm test` | 90 tests passed in 5 files | 65 domain, 19 real PostgreSQL integration, 6 HTTP-boundary tests |
| Domain property checks | 1,800 generated cases passed | Exact money, conservation and deterministic allocation within the domain suite |
| `npm run build` | Passed | Optimized Next.js production build and route generation |
| `TALLIE_VERIFY_VOLUME=1 npm run verify:api` | 13 groups passed | Independent HTTP verification against the running production app and worker |
| `npm audit --json` | Zero known vulnerabilities | Full dependency audit at the time checked; not a future guarantee |

Database tests create and remove unique test schemas. The HTTP harness creates isolated synthetic demo workspaces. Neither uses real financial data. CI is configured but has not executed remotely.

### Payment and data checks

- Concurrent duplicate creates produce one expense; changed payload under the same key is rejected.
- Concurrent approvals and competing reviews produce one operation and one simulated settlement effect.
- Reviews bind exact payer, payee, session, source, amount, request version, digest and expiry.
- Workspace/participant isolation, revoked sessions, unexpected origin and malformed money inputs are rejected.
- Worker transaction rollback/recovery and replay leave a single local settlement effect.
- Zero shares produce no payable request and retain participant access.
- Cancellation, issue pause and payment races preserve request state and amount consistency.
- A 1,632-request regression checks complete per-friend and aggregate balances beyond the 200-request display cap. Paid/canceled requests are excluded; each friend has separate amounts in both directions, with no implicit netting.
- Expense detail retrieval remains complete beyond the dashboard's 100-expense and 200-request limits. A participant sees all allocated shares, but only their own payer/payee request details. Another participant's issue reason stays private.

These are simulator guarantees. PostgreSQL atomicity does not make an external bank operation atomic with our database; real-provider dispatch, unknown-outcome reconciliation and return handling remain separate work.

## Observed browser journeys

Performed in the in-app browser against the local app, including the production build:

1. Enter a private demo workspace from the Tallie welcome screen.
2. Create the $117 sample dinner by item: Alex $45.50, Maya $26.00, Leo $45.50; two independent requests.
3. Review an exact payment, explicitly approve it, observe processing then completion, and verify updated totals.
4. Send the exact $9.25 matching an existing coffee request; route through that request rather than creating a second repayment.
5. Send $18.30 directly with the optional note left blank; review displays “Just because.” and completes through the worker.
6. Preview an equal $10.01 split, then publish a custom $5.01/$5.00/$0.00 split; the zero share reads “No payment needed.” Cancel the payable share; history reads “Closed,” never paid.
7. Flag an incorrect movie-night share; payment action is removed and the request is paused. The detail shows the reason and correction guidance to authorized participants.
8. Switch Alex/Maya demo profiles; shared expenses and payment perspective update. Friends, activity and search/filter navigation work.
9. Open a split composer by keyboard, verify initial focus, close with Escape and observe focus return. Native modal focus containment and reduced-motion rules are implemented.

Desktop and 390px/320px mobile views were inspected. The 320px payment flow had no horizontal document overflow. Targeted computed text-contrast checks led to darker secondary labels; payment review and completion text passed those spot checks. Decorative brand marks were excluded. This is not a full screen-reader, WCAG, cross-browser or performance certification.

## Current limits and next evidence

- Real signup/recovery, Natural activation and payments, deposits/withdrawals, uploaded receipt extraction/redaction, iMessage/SMS and Venmo handoff are not connected. Capability flags remain false and non-demo operation fails closed.
- Dashboard lists are bounded (100 expenses, 200 requests, 100 activities). Financial totals and per-expense detail are complete; full history pagination is still required before an unrestricted beta. Friend history explicitly describes recent moments and provides an empty state.
- The demo balance is a named simulated source, not a tracked bank/wallet account balance.
- Production rate limits, database role separation, restore drills, operations dashboards, support tools and full accessibility/device testing remain pending.
- Founder setup is listed in [provider-setup.md](provider-setup.md). Track each actual sandbox/device result in [verification-register.md](verification-register.md), then update [implementation-tracker.md](implementation-tracker.md).

## Visual captures

- [Desktop overview, 1280px](implementation-screenshots/tallie-desktop.jpg)
- [Mobile overview, 390px](implementation-screenshots/tallie-mobile.jpg)
- [Mobile split detail, 390px](implementation-screenshots/tallie-split.jpg)

The final split-detail contrast spot check returned no text below its applicable threshold. The final 1280px desktop view had no horizontal document overflow. Expense detail loading preserves focus return to its original expense button. Temporary viewport overrides were reset after capture.

## September 26, 2026 — provider integration verification

### Commands and evidence

- `npm run db:migrate`: migrations 003 (receipts) and 004 (development phone proof) applied to the dedicated Tallie database.
- `npm run check`: formatting, eight TypeScript projects, **152 tests / 11 files**, production build passed. New test count is 38 receipt tests plus 24 phone tests; core 90 tests remain passing. Provider calls are mocked in these tests.
- `npm audit`: zero known vulnerabilities after Sharp upgraded to 0.35.4. The build completed without the earlier dynamic-storage tracing warnings.
- `npm run verify:api`: **12 real-HTTP simulator groups passed** with optional integrations enabled. Previous 13-group volume run is retained above and was not rerun because aggregate money behavior was unchanged.
- `npx tsx scripts/evaluate-receipts.ts --live-synthetic`: three live fixture extractions passed through web, PostgreSQL jobs and receipt worker. [Machine-readable synthetic results](verification/receipt-live-results.json) and [evaluation interpretation](receipt-evaluation.md).
- Read-only credential checks returned 200 for OpenAI model listing and Sendblue Verify service listing; one development Verify service created 201. No real phone challenge or outbound message initiated by this task.
- Scanned 325 generated client/server files and 22 trace manifests: no configured provider/encryption key values embedded and no private runtime paths in traces. Root `.env`, web `.env.local` and `.tallie` are gitignored. This is evidence for these generated artifacts, not a general secret-detection audit.
- `RECEIPTS_ENABLED=false npm run receipt-worker` exits cleanly. The runner permits this optional process to exit while manual app/core worker continue.

### Browser-observed behavior

- Receipt sample button uploaded actual synthetic PNG bytes through the same upload endpoint and ran a fourth live extraction.
- All absent adjustments remained blank until explicit user confirmation. Changing tip from 18 to 17 made the displayed $1 mismatch block import. Restoring 18 and acknowledging review enabled import.
- Adding two friends preserved both extracted items and kept split method unselected. By-item selection and excluding Maya from wine yielded 4550/2600/4550 cents, then created two independent simulated requests and a shared structured breakdown.
- Receipt review inspected on 1280px desktop and 390px mobile. Item field values, selection chips and money preview remained usable with no horizontal page overflow. [Mobile item split screenshot](implementation-screenshots/tallie-receipt-items-mobile.jpg).
- Sendblue availability loaded; the phone test rendered explicit development-only scope and manual send instructions. The final phone form was inspected at 390px and 320px with no horizontal overflow. [Phone screenshot](implementation-screenshots/tallie-phone-test-mobile.jpg). No user phone was submitted by automation. Device proof is pending the founder's manual test.

### Material limits

System file-picker/camera access, iPhone/Mac/Android Messages behavior, signed callbacks, broad receipt accuracy, actual signup/recovery, image redaction and real money are **not** verified by this slice. The sample button tests browser upload/extraction/review but does not establish HEIC support or native camera behavior. Original and normalized photos stay owner/session-private, and expense publication has no source-image provenance link yet. Local environment separation shares an OS user and DB role; it is not a production sandbox.


## September 26 — account, invitation, message and deployment verification

- `npm run db:migrate` applied005–011 to the existing isolated local database; no reset/truncate performed.
- Formatting, TypeScript, **270 tests in19 files**, and production build passed. External transports are mocked in tests; actual PostgreSQL transactions and cryptographic WebAuthn fixtures are exercised.
- Fresh startup reports allfour roles ready. Ordinary messaging sends remain disabled. The account app is at `/`, synthetic transfers at `/demo`; the deployment uses `APP_MODE=beta` to disable demo.
- Eleven real HTTP read/deny checks passed for health/config, anonymous social/messages/receipt/passkeys access, signup origin/input, anonymous social/connect mutations and webhook authentication. No valid phone proof was started by this check.
- Anonymous signup/recovery entry inspected in the in-app browser at desktop1280 and mobile390/320. Mobile document widths matched viewport widths; temporary viewport overrides were reset. Native passkey enrollment and authenticated account screens require founder device testing.
- Account tests verify restricted onboarding, missing user verification, wrong-origin/account authentication, exact same-user session recovery, no phone-only takeover, single-use recovery codes, last-passkey protection, stale proof and same-result retry.
- Social tests verify phone-bound invitation privacy, concurrent claim/revoke, forward denial, future canonical contacts, complete aggregate totals and allocation semantics.
- Messaging/application tests verify duplicate webhook handling, canonical provider checks, STOP locking, invalid/revoked grants, encrypted media jobs, extraction-warning review, stable publication identity and resuming exact custom input after an interrupted result. No tests use real messaging/AI credentials.
- Private S3 SDK tests cover conditional originals, streaming limits, safe errors, owner expectations and object deletion. These are not evidence that a real AWS policy/lifecycle has been provisioned correctly.
- Deployment preflight built and ran a native ARM64 Linux image asUID1000 with fake credentials and isolated schema; all11 migrations and four runtime roles passed. AMD64 QEMU crashed during page-data collection after compile/typecheck; native AMD64 and hosted operation remain unverified. See [deployment record](deployment.md).
- Specific build scan:902 generated files, zero configured credential matches, zero private paths in traces. Runtime npm audit found zero known vulnerabilities.

A local generated-type conflict was traced to four byte-identical `* 2.ts` copies in ignored `.next/types`; those duplicate generated files were removed and the final checks passed. No source or user data was removed.

Current limitations and the next device/provider checks are maintained in the [tracker](implementation-tracker.md). This milestone does not establish live payment capability, public webhook delivery, native camera/HEIC support or redacted receipt sharing.
