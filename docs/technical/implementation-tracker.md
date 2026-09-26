# Implementation tracker

**Updated:** September 26, 2026  
**Current phase:** Real-account application implemented locally; authorized free Render preview being prepared. Private `kavin1001/tallie` repository created, source publication and hosting verification pending.  
**Provider status:** Sendblue phone proof worked in the earlier development test. OpenAI synthetic receipt extraction passed earlier live checks. Natural sandbox and consumer-P2P acceptance remain pending. The free hosted preview disables receipt processing and messaging, retaining Sendblue Verify for signup.

**Current deployment constraint:** $0 infrastructure budget. Default Render configuration is being changed to free web/PostgreSQL; paid worker topology is retained separately. Hosting access is being supplied through browser sign-in. A local ignored hosting-credential template exists as an optional API alternative. No credential values belong in these notes.

Status values: `Not started`, `In progress`, `Blocked on evidence`, `Implemented`, `Verified in sandbox`, `Verified in pilot`. A working mock is not a completed live integration.

The table below records the original implementation baseline; dated milestones later in this document supersede those original statuses.

| Workstream | Status | Requirements / dependencies | Completion evidence to add |
|---|---|---|---|
| Living technical design and ADRs | Design complete | PRD scope | Initial design and decision log |
| Design model + PostgreSQL experiments | Passed locally | INV-01 through relevant modeled invariants | [Validation guide](validation/README.md) |
| Natural public schema audit/checker | Passed public checks | G-001–G-009 remain runtime gates | [Checker](verification/README.md) |
| Provider/access spikes | Not started | Founder access; G-001–G-014 | Sandbox fixtures, device observations, partner references |
| Repository/runtime/CI/deploy foundation | Local implementation complete; CI configured, hosting pending | ADR-001–004, ADR-017 | Lockfile, build, migration pipeline, role tests |
| Auth/session assurance/guest scope | Isolated demo sessions implemented; real auth pending | ONB/ID/PRIV; G-010–011, G-019 | Signup, recovery, access-denial tests |
| Expenses/calculations/revisions | Equal/custom/item publishing implemented; revisions pending | SPL/REV/P2P; INV-01/03/07 | Actual domain property and integration tests |
| Durable operations/inbox/outbox | Local operations + simulator implemented; provider inbox/outbox pending | PAY-01/02; INV-02–08 | Real migration/worker crash/concurrency tests |
| Receipt ingestion/AI/redaction | Not started | SPL-01, PRIV-02; G-015–016 | Evaluation report, isolation/privacy checks |
| Request creation/fulfillment/Natural activation | Not started | REQ/PAY; G-001–009 | End-to-end sandbox request and payment |
| Direct sends/deposit/withdraw | Simulated direct sends implemented; live flows pending | PAY-04/06/07 | Exact-source approval, insufficient balance and recovery fixtures |
| Corrections/returns/support issues | Issue pause + cancellation implemented; corrections/returns pending | REV/OPS; G-004–005 | Cancel race, residual accounting, returned-payment UX |
| Venmo handoff/external confirmation | Not started | EXT-01–04; G-014 | Devices, lane switches, guest-later-signup, manual provenance |
| iMessage/Verify/SMS notifications | Not started | MSG-01–03; G-009, G-012–013 | Real device, consent, duplicates/unknown delivery |
| Mobile web/accessibility | Local browser flows verified; full accessibility/performance audit pending | UX/A11Y; G-020 | [Observed flows](implementation-verification.md), responsive and keyboard checks |
| Observability/support/restore | Not started | OPS; G-017–018 | Dashboards, runbooks, audited repair tools, timed restore |
| Free private beta | Not started | All applicable live gates passed | Named operator, cohort, measured costs/repeat use |

## First implementation slice

1. Confirm provider access and run M0 spikes while creating the repository foundation.
2. Implement auth/assurance and a manual $117 expense with three participants.
3. Publish two independent simulated requests with deterministic allocation and one-time approvals.
4. Pass actual database concurrency/crash tests before connecting money mutations.
5. Replace the simulator with the gated Natural adapter; add receipts and iMessage using the same commands.

The first slice is sequencing, not a reduction of the PRD. All P0 features must reach their required verified status before calling the full MVP complete.

## Work-item template

```text
ID / owner:
PRD requirement + design section + ADR:
Acceptance behavior:
Dependencies/gates:
Data/API/migration impact:
Test/evidence links:
Implementation status:
Operational/recovery impact:
Next action:
```

Update this tracker as work is implemented. Add commit/PR/test references rather than changing a row to Done based on a screenshot or successful happy-path mock.


## September 25 implementation milestone — Tallie

### Implemented

- Project name confirmed as **Tallie** by the founder.
- Node 24 / Next.js 16.3.6 / React 19.3 / PostgreSQL 17 npm workspace with strict TypeScript, self-hosted DM Sans and Instrument Serif, isolated local database and a separate durable simulator worker.
- Warm ivory/pine/citron responsive UI: welcome, payment overview, moments/search/filters, friends, activity, profile switching, split composer, full expense breakdown, and approval/processing/completion states.
- Equal, custom, and item splits; explicit choice every expense; integer-cent math and stable-ID rounding. A zero share is “No payment needed,” not an original-payer claim.
- Atomic expense publication, immutable participant/amount snapshots, one independent request per positive non-payer share.
- Hashed opaque HttpOnly demo sessions; per-visitor synthetic data; persona session rotation; participant/workspace authorization; Origin checks, bounded JSON and strict schemas.
- Immutable five-minute review, digest verification, explicit consent, stable idempotency/payload binding, single reservation and one settlement effect. Unknown browser response uses the same retry identity.
- Worker restart recovery and transactional simulated completion. Direct sends route an exact matching existing request back to that request.
- Request issue/collection pause and versioned cancellation. Canceled shares are never described as payments.
- Complete dashboard and per-friend balances independent of visible history limits. Expense details and authorized request actions load independently, including older expenses reached through activity. Peer issue notes stay private.
- Provider setup instructions at [provider-setup.md](provider-setup.md). No API credentials or customer data are stored.

### Verification evidence

- **65 domain implementation tests** plus **1,800 generated property cases** passed.
- **25 backend tests**, including **19 actual PostgreSQL integration tests**, passed. Combined implementation suite: **90 passing tests**.
- Independent HTTP harness passed **13 groups** including concurrent creates/approvals, tenant isolation, strict input, review replay and 208-request aggregate completeness.
- Formatting, strict TypeScript across all workspaces/scripts, and production build passed.
- Browser observed the $117 item split create two requests, payment review/processing/completion, direct sends, zero shares, cancellation, issue pause, profile switching, friends and activity. Desktop plus 390px and 320px mobile inspected. [Full verification report](implementation-verification.md).
- The volume regression covers 1,632 requests across four friends in both directions, excluding paid/canceled amounts. Older expense details remain actionable beyond both display caps, with participant privacy tested.
- Initial dependency audit found a vulnerable older Kysely version; upgraded to 0.29.6. Audit now has zero known vulnerabilities.
- Actual testing found and fixed a malformed cents input causing 500, a capped-list balance calculation, a publication ACL insertion gap, and settlement amount consistency.

### Explicit limits

This is an implemented **local simulated vertical slice**, not a released financial MVP. Real Better Auth/passkeys/phone recovery, Natural onboarding and payments, deposits/withdrawals, receipt upload/extraction/redaction, Sendblue delivery, Venmo guest handoff, production roles/restore/observability, corrections and returns are not implemented. Public/synthetic receipt data is not evidence of redaction. The iMessage panel is clearly labeled as a preview. Capabilities are false, and a non-demo runtime fails closed.

### Immediate next action

Use founder-supplied **sandbox** access to execute the Natural and identity provider spikes in the verification register, starting with consumer P2P program acceptance and targeted onboarding. The local web app and worker can continue running without credentials. Add production identity, provider dispatch/reconciliation, receipt ingestion and iMessage as separately verified slices. Never connect live money by simply swapping the simulator's transport.

## September 26 integration milestone — receipt capture and phone proof

### Implemented locally

- Verified configured OpenAI and Sendblue credentials using read-only calls, both HTTP 200. Created one Sendblue development Verify service (HTTP 201). No credential values entered logs, docs, or browser bundles.
- Receipt web upload/poll/private preview routes, isolated Sharp 0.35.4 decoding, PostgreSQL lease/retry/quota jobs, OpenAI structured extraction, exact-cent reconciliation and sensitive-text guards. The uploader must review before any ordinary expense command. Migration003 applied.
- Tasteful receipt capture/review in the split composer: sample photo, progress, photo comparison, editable labels/amounts, explicit absent-adjustment confirmation, mismatch blocking, privacy acknowledgement, retained items when selecting friends, and explicit split method every time. Discounts are editable; a service charge becomes a shared item with editable assignees.
- Sendblue reverse-OTP development test under Profile: expected phone/service/session binding, encrypted phone/code fields, safe retry, bounded polling, expiry/cancellation and atomic one-time proof. Core worker removes expired ciphertext every minute. Migration004 applied.
- Role-specific local launcher: OpenAI secret only enters receipt worker; Sendblue secrets only enter web. Private receipt paths and environment files excluded from build traces. Optional receipt worker can be disabled without stopping the manual app.
- No receipt image is published to participants. Reviewed expense details use existing allocation and authorization rules. Phone proof purpose is fixed to `connect_test`; it creates no real account/session/payment authority.

### Evidence

- **152 passing implementation tests in 11 files**: previous 90 + receipt 38 + Sendblue 24. New suites include 10 receipt and 17 phone actual PostgreSQL integration tests. External provider calls are mocked in automated suites.
- `npm run check` passed formatting, all eight TypeScript projects and optimized production build. `npm audit` reports zero known vulnerabilities; Sharp upgraded after detecting decoder dependency advisories.
- **12 independent real-HTTP simulator groups** passed on the provider-enabled app. Prior volume check remains recorded separately; it was not rerun for this integration slice.
- **Three live synthetic OpenAI fixtures passed**: correct visible totals/components, unreadable tip remains null, hostile printed instructions ignored, forbidden synthetic identifiers absent, owner preview allowed and anonymous preview denied. Upload-to-review observed 3.1–4.6 seconds. [Results](verification/receipt-live-results.json).
- Fourth real extraction exercised the browser UI through **Try a sample photo**. An edited $17 tip correctly blocked continuation on a $1 mismatch; after correction/review, adding friends retained both items. Excluding Maya from wine yielded $45.50/$26.00/$45.50 and two simulated requests.
- Receipt editor inspected at desktop 1280px and mobile 390px; phone form inspected at mobile 390px and 320px. No horizontal page overflow observed. Native camera/file-picker interaction remains a device check.
- Scanned 325 generated client/server build files and 22 trace manifests: no configured credential values embedded, no `.env` or private `.tallie` paths in traces. Secret/config/runtime files remain ignored.
- Testing/review caught and fixed missing claim LIMIT, same-millisecond phone challenge ordering, lost-commit-response file cleanup, definitive-upload-error form lock, misleading “no receipt uploaded” copy, and dynamic private-storage tracing.

### Current runtime and remaining work

Latest production preview is running at `http://localhost:3000` with web, simulator worker and receipt worker. Configure root `.env`; no keys are needed in chat. Live extraction is billable provider use, while every payment remains simulated.

The founder has been asked to initiate the phone test and send the prepared code manually. Device completion is **pending**, and no phone challenge was initiated by the implementation task. A null/mismatched provider phone fails closed. Real signup/passkeys/recovery and signed Verify callbacks still need an identity integration after device evidence. The persistent iMessage agent, Natural onboarding/payments, Venmo fallback, HEIC, full redacted receipt sharing, production storage/role isolation and broad extraction benchmark remain open.

**Next concrete action:** observe the founder's phone test (success or safe failure), then implement production identity as a separate reviewed slice. Continue Natural consumer-P2P approval/sandbox access in parallel. Do not promote a demo phone proof or simulator transfer into financial authority.

## September 26 — real accounts, invitations and messaging implemented locally

### Authorized scope and current runtime

Founder reported successful development phone verification; the database confirmed one verified test. Natural sandbox access and consumer P2P acceptance remain pending. Founder authorized real signup, friends/invitations, the iMessage agent, and deployment preparation with no existing hosting/domain.

The production preview at `http://localhost:3000` now serves the real-account app. The old synthetic experience moved to `/demo`, available only with `APP_MODE=demo`. Four processes run: web, maintenance, receipt extraction, messaging. All real-account money movement remains disabled. Messaging is configured locally but sending is disabled and no public callback is registered. No new real phone challenge, message or AI call was initiated during this implementation slice.

### Implemented

- **Identity:** Better Auth1.7.6 with official passkeys, verified user presence, persistent UUID accounts and HttpOnly sessions. Phone proof produces restricted enrollment; a passkey is required before private access. Existing-account recovery requires a single-use recovery code plus fresh same-phone proof, revokes old sessions, and cannot be replaced by phone-only login. Credential management, last-passkey protection, recovery-code download, bounded proof cleanup, consumed-result retry and session-bound fresh channel proofs are implemented. [Identity details](identity-integration.md).
- **Friends and invitations:** canonical encrypted phone contacts, exact recipient resolution, no account enumeration, high-entropy fragment invitation links, generic anonymous previews, correct-phone claims, scope-limited expense access, forward/replay/revoke protection, ad hoc equal/custom/item splits, and immutable exact-cent shares. Signup preserves the invitation. Native share/copy and pending-share cancellation are available. [Social details](social-integration.md).
- **Messages:** authenticated shared-secret callbacks, canonical provider reads before commands, encrypted durable inbox/outbox/drafts, exact contact clarification, explicit split-method choice, safe equal-split chat review/confirmation, web continuation for item/custom/uncertain receipts, and idempotent publication across chat/web. Already-approved web payloads are encrypted and can finish after a lost response/reload. STOP, fresh enrollment, session revocation, notification consent, duplicate callbacks, unknown sends and media URL/DNS/size restrictions are handled. Warnings in receipt extraction require web review. [Messaging details](messaging-integration.md).
- **Account receipt bridge:** receipt rows belong exclusively to a demo session or real account; strong session/channel authorization is held through upload publication. Authenticated account previews remain private. S3 and filesystem adapters share bounded immutable source handling. [Storage details](deployment-storage.md).
- **UI:** premium responsive account entry, verification, enrollment, sign-in/recovery, empty dashboard, people/invitations, split composer/details, passkey/recovery settings and Messages consent/draft recovery. Account-bound request headers and keyed components reject cross-tab identity changes. All payment labels describe saved shares pending payment setup.
- **Deployment:** pinned non-root Docker image, current-schema-validated Render Blueprint, private PostgreSQL, separate four service roles, scoped secrets, S3/IAM/lifecycle instructions and rollout/restore checks. No infrastructure provisioned or paid resources created. [Deployment guide](deployment.md).
- Migrations005 through011 applied to the persistent local database; prior demo/test data was preserved. Application encryption/session secrets were generated only in ignored local configuration, with restrictive file permissions.

### Verification

- **270 implementation tests in19 files passed**, with mocked external provider calls. Previous152 + identity20 + social19 + messaging/application integration59 + account receipt9 + S3 storage11.
- Actual PostgreSQL/WebAuthn coverage includes user-verification flags/signatures, wrong origins and accounts, onboarding restriction, proof consumption/recovery, expired response retry, concurrent invitation claims, wrong-phone access, exact rounding, STOP/publication races, duplicate deliveries, chat/web identity, resumed custom publication, and no real-money operation creation.
- Formatting, strict TypeScript across all workspaces/scripts and optimized Next production build passed. Runtime dependency audit reports zero known vulnerabilities.
- **11 real HTTP boundary checks passed:** health/config; anonymous social/messages/receipt/passkeys denial; wrong signup origin; invalid signup input; unauthenticated contact/message connection; rejected webhook authentication. These create no real user or message.
- Browser inspected landing/signup and recovery entry at1280px desktop,390px and320px mobile. No horizontal overflow at either mobile width. The founder was asked to test native signup/passkeys; authenticated account UI and real device app switching are not yet browser-verified by this slice.
- Native Linux ARM64 Docker build and isolated-database smoke passed: all11 migrations, UID1000, web200, demo404/mutation503 inbeta, anonymous social401, and allthree workers healthy with fake credentials/no jobs. AMD64 emulation compiled/typed successfully but QEMU crashed during page-data collection; native AMD64/Render remains a hosting verification gate.
- Scanned902 generated build files from the first integrated candidate: zero configured credential matches and zero private `.env`/`.tallie` paths in deployment traces. Docker context also passed a separate secret/path audit. These are specific artifact checks, not a universal security guarantee.

### Remaining gates and next concrete action

1. Founder manually completes phone signup/passkey on a supported browser, saves recovery codes, signs out/in and reports the result. Test two consenting users claiming a private expense invitation once public HTTPS is available. Localhost credentials do not migrate to a new relying-party domain.
2. Choose a stable HTTPS origin, hosting account/repository and private S3 bucket; apply the prepared deployment only after reviewing resource cost/configuration. Verify actual S3 IAM/lifecycle and backup restore; DB roles currently share application authority and need hardening for broader release.
3. Configure Sendblue inbound/status callbacks and confirm assigned/shared-line routing with consenting devices. Verify JPEG/PNG/WebP receipt media in real provider payloads. Then deliberately enable sending. HEIC, Android/SMS behavior and broad natural-language coverage remain open.
4. Obtain Natural sandbox and consumer-P2P approval before implementing financial onboarding, payment authorization/execution and reconciliation. Venmo fallback, full redacted receipt image sharing, broad receipt evaluation and production operations remain separate milestones.

There is no local implementation blocker to testing signup/friends now. Actual external chat delivery and money movement have explicit provider/hosting gates; do not describe them as live.
