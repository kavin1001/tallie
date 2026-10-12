# Local HTTPS production connection test

This runtime tests Natural's production account-connection path against a dedicated local database. It does not enable real-money payment execution. The existing localhost3001 sandbox and hosted phone-demo remain separate.

## Configuration

The launcher reads **only** `.tallie/production-connect.env`, which is ignored by Git. Use file permissions `0600`. It does not merge the root `.env`, inherited provider keys, or inherited Node startup options.

Required fields:

```dotenv
APP_ORIGIN=https://the-current-public-test-host
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:55434/tallie_production_connect
BETTER_AUTH_SECRET=
IDENTITY_ENCRYPTION_KEY=
SENDBLUE_API_KEY_ID=
SENDBLUE_API_SECRET_KEY=
SENDBLUE_VERIFY_SERVICE_SID=
NATURAL_PRODUCTION_API_KEY=
NATURAL_PRODUCTION_AGENT_KEY=
NATURAL_PRODUCTION_AGENT_ID=
NATURAL_PRODUCTION_PLATFORM_PARTY_ID=
NATURAL_PRODUCTION_CONNECT_LIMIT_MINOR=1000
NATURAL_PRODUCTION_WEBHOOK_SECRET=
```

`NATURAL_PRODUCTION_WEBHOOK_PREVIOUS_SECRET` is optional during secret rotation. Generate fresh identity encryption and session-signing secrets for this database; retain them securely for as long as these test accounts exist. The required database is exactly `tallie_production_connect` on loopback, without URL query parameters. Create it separately before migrations. Never point this runtime at the app's sandbox or hosted database.

The launcher fixes `APP_MODE=beta`, `APP_HOST=127.0.0.1`, `PORT=3003`, production connection and accepted-invitation callbacks enabled, and preview, phone-demo, sandbox, sandbox reconciliation, receipts and outgoing Messages disabled. Unexpected configuration fields and boundary overrides fail closed. Natural provider credentials are scoped by role; the worker does not receive identity encryption, session-signing, Sendblue or webhook-signing secrets. Underlying Natural credentials may still permit more operations than the worker's exposed read-only methods.

## Run

The web process uses the existing optimized build. If code changed, run `npm run build` before starting web processes; concurrently running processes share that build directory.

```sh
node scripts/run-connect-local.mjs check
node scripts/run-connect-local.mjs migrate
node scripts/run-connect-local.mjs web
```

In a separate process:

```sh
node scripts/run-connect-local.mjs worker
```

Keep the HTTPS tunnel, web process, worker and PostgreSQL running through the test. The tunnel should forward only to `http://127.0.0.1:3003`. Register the production callback URL as:

```text
https://the-current-public-test-host/api/webhooks/natural/production
```

Subscribe to `agent_delegation_invitation.accepted` with the agreed Natural source selection. Store the returned signing secret directly in the ignored configuration file. Registration, active source coverage and signed delivery need their own observed verification; a passing launcher check establishes configuration validity only.

## Device test boundaries

- Open the **HTTPS address**, verify the phone and enroll a passkey. Localhost phone-demo accounts are not copied into this database.
- Tallie uses the exact HTTPS hostname as its WebAuthn relying-party ID. A different tunnel hostname does not share passkeys or browser sessions. Preserve the running tunnel throughout onboarding and test continuation; a random tunnel is not a durable production origin.
- Begin Natural account setup from the authenticated Tallie account, complete the provider-owned flow, and return to Tallie. A return redirect is not acceptance evidence; the worker verifies canonical provider event, grant and wallet data.
- Production payment buttons are not implemented/enabled by this setup. Provider identity checks and bank linking require the account holder's interaction. Do not describe wallet sandbox evidence as a tested bank debit or withdrawal.
- Before stopping or changing a temporary tunnel, deactivate its provider webhook. A stale callback URL can later become unreachable or route elsewhere. Retain the database, encryption keys and operation journal for investigation; do not delete an account to work around an uncertain provider invitation.

## Implementation verification

The launcher has **35 boundary tests** covering role scoping, inherited secret/startup isolation, disabled capabilities, strict local database and HTTPS origin requirements, missing identity/provider settings, owner-only file permissions and symlink rejection. These tests use synthetic values and start no tunnel, provider call or real-money operation.
