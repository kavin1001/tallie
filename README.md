# Tallie

**Good times. All square.**

A considered place for money between friends. Tallie has persistent accounts, passkeys, recovery, phone-bound invitations, receipt capture and a durable messaging agent. Natural P2P approval is founder-confirmed. The development branch includes sandbox payments, production account connection and a separately gated local owner-wallet pilot. **General production payments remain disabled.** The separate `/demo` experience contains synthetic people and simulated transfers.

Current development lives on [`codex/natural-sandbox`](https://github.com/kavin1001/tallie/tree/codex/natural-sandbox). `main` serves the earlier phone-demo release. Publishing source does not release the Natural integration: founder local testing and explicit approval are still required before production deployment.

## Run locally

Requires **Node.js 24+** and a running Docker engine.

```sh
git clone --branch codex/natural-sandbox https://github.com/kavin1001/tallie.git
cd tallie
npm ci
npm run setup
npm run dev
```

Open [Tallie at localhost:3000](http://localhost:3000). The main app uses real accounts. Open the [demo](http://localhost:3000/demo) to explore without provider credentials; the default local setup enables it.

Setup preserves existing configuration, generates missing local encryption/auth secrets, starts the isolated PostgreSQL17 container on port **55434**, and applies migrations. Root `.env` is the canonical local configuration; never put credentials in chat or `NEXT_PUBLIC_` variables. `apps/web/.env.local` is only a core-settings fallback. The local database fixture password is not suitable for hosting.

The launcher starts four processes and distributes only each role's required credentials:

- **Web:** Next.js, phone verification, authenticated accounts, private invitations and message webhook intake.
- **Maintenance:** expired phone-proof cleanup; simulator processing only in `APP_MODE=demo`.
- **Receipts:** private image decoding and OpenAI extraction. This is the only process given the OpenAI key.
- **Messages:** canonical Sendblue event checks, receipt conversations, draft publication and durable notifications. Sending requires explicit configuration, HTTPS and user consent.

For a local preview of the optimized build, run `npm run build`, then `npm start`. The local server binds to localhost. Hosted services use `APP_HOST=0.0.0.0`, `APP_MODE=beta` and an exact HTTPS `APP_ORIGIN`.

## Real account flow

1. Configure Sendblue credentials and its Verify service in `.env`. Follow [provider setup](docs/technical/provider-setup.md).
2. Start signup, send the prepared verification code yourself, add your name, and create a passkey with your device. Opening Messages alone does not verify a number.
3. Save recovery codes under **Your account → Sign-in & recovery**. Recovery requires a saved code and fresh proof of the same phone number; a phone alone cannot take over an existing account.
4. Add a friend by phone, create a split, and share a private invitation link. The invited person verifies the matching number before seeing the details. Invitations survive signup in the same browser tab.
5. Choose equal, custom or item splitting every time. Shares are stored with exact integer-cent arithmetic. With the default configuration, they remain pending payment setup. Explicitly enabled sandbox flows use synthetic Natural balances and test payments.
6. With OpenAI enabled, upload a receipt and review its extracted details. Images remain private to the uploading account. Full redacted image sharing is a separate pending feature.
7. Connect **Tallie in Messages** with explicit consent and fresh phone proof. Public HTTPS callbacks and a working Sendblue messaging line are required for actual conversations. `MESSAGING_SEND_ENABLED=false` is the default.

Passkeys are bound to their web origin. A localhost passkey does not migrate to a hosted domain; choose the public app address before inviting outside testers. Native iPhone/Android verification, passkey and messaging journeys still need device validation.

The hosted phone-demo can use explicitly configured phone-only demo identities; this does not grant production payment authority or weaken existing passkey accounts. Natural setup and payment features are opt-in. Follow the [Natural integration guide](docs/technical/natural-integration.md) for sandbox testing, [payment operations](docs/technical/payment-operations.md) for production connection gates, or the [isolated owner-wallet runbook](docs/technical/local-owner-payment.md) for the separately approved local pilot. None of those provider credentials or private runtime configurations are included in the repository.

## Demo

`APP_MODE=demo` enables `/demo` and its isolated synthetic API. Try **New split → sample dinner → By item**: the $117 example allocates $45.50/$26/$45.50. Review and approve simulated transfers, switch demo profiles, or flag a correction. A worker resumes approved simulated operations after restart.

`APP_MODE=beta` disables demo entry and simulator commands. Demo verification proofs, identities and money states cannot become real account authority. Optional demo receipt extraction uses real OpenAI calls; automated suites mock external providers.

## Verify

```sh
npm run check
```

This runs formatting, TypeScript, tests and an optimized build. Tests create uniquely named PostgreSQL schemas and remove them; they do not truncate local development data. Provider calls are mocked. Coverage includes actual WebAuthn signatures, proof replay, invitation access, exact allocation, account receipt isolation and concurrent message/web publication.

The existing real-HTTP simulator harness remains available in demo mode:

```sh
npm run verify:api
TALLIE_VERIFY_VOLUME=1 npm run verify:api
```

The opt-in receipt evaluation uploads synthetic fixtures and incurs real extraction calls:

```sh
npx tsx scripts/evaluate-receipts.ts --live-synthetic
```

See the dated [implementation tracker](docs/technical/implementation-tracker.md) for evidence and outstanding checks. The October 11 publication gate passed formatting, TypeScript, **975 tests across 52 files** and the optimized build; [GitHub CI also passed for that development snapshot](https://github.com/kavin1001/tallie/actions/runs/38207749818). Subsequent dependency updates and their verification are recorded separately in the tracker. Automated checks do not establish live-money readiness.

## Deploy

**Hosted phone-demo:** [tallie-web.onrender.com](https://tallie-web.onrender.com), last recorded deployment `94a2240`. HTTPS/session/access-control checks passed at deployment; current availability has not been reverified by the repository-readiness audit. Blueprint sync and service deployments are manual. This hosted release does not include the Natural development branch.

The default `render.yaml` retains the **free infrastructure preview**: one free web service and one free PostgreSQL database. The founder's current recurring budget ceiling is **$100/month**; that approval has not upgraded the deployed resources. The preview supports accounts, contacts, invitations and manual splits. Receipt capture, messaging intake/delivery and payments are disabled. It starts with database migrations and runs proof cleanup alongside the web process. See the [deployment guide](docs/technical/deployment.md) for verification and deployment status.

Render's free web service sleeps after inactivity, and this free database expires **October 26, 2026**, without backups. Public database access is blocked. Use disposable test data and move to the chosen stable domain before enrolling a wider cohort. Sendblue verification is separate provider usage and is not covered by the infrastructure budget.

The separate `deploy/render-paid.yaml` preserves the full web/three-worker/private-database topology for a later approved upgrade. Private S3 receipt storage remains a separate provisioning step, subject to the AWS account's verified free-plan eligibility; the free web preview requires no AWS credentials. Hosting credentials belong in ignored `.env.hosting.local`, never in source control or Docker build arguments.

## Structure

```text
apps/web/              Real-account UI/APIs and separate synthetic demo
apps/worker/           Maintenance and optional simulator processing
apps/receipt-worker/   Image normalization and extraction
apps/messaging-worker/ Durable conversation and notification processing
packages/identity/     Better Auth, verified phone proof, passkeys, recovery
packages/social/       Contacts, phone-bound invitations, real-account splits
packages/messaging/    Sendblue transport, encrypted inbox/drafts/outbox
packages/app-services/ Account/contact/receipt/messaging integration
packages/domain/       Pure bigint money and allocation rules
packages/db/           SQL migrations and typed simulator data layer
packages/receipts/     Capture, validation, filesystem/S3 storage and jobs
packages/channels/     Sendblue Verify adapter and encrypted phone storage
packages/natural/      Natural provider adapters and strict response validation
packages/payments/     Payment reviews, durable operations and reconciliation
scripts/               Setup, scoped service launcher, HTTP verification
docs/                  Living product/design decisions and test evidence
```

Start with the [documentation index](docs/README.md). Keep customer data and secrets out of code, tests, screenshots and continuity notes. See [Security](SECURITY.md) for private vulnerability reporting and configuration guidance.
