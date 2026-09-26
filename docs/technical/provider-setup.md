# Provider setup guide

**Updated:** September 26, 2026  
**Evidence:** September 26 live checks: OpenAI model-list access returned HTTP 200; Sendblue Verify service-list access returned HTTP 200; one development Verify service was created (HTTP 201). Three synthetic receipts passed real OpenAI extraction through the implemented worker. The founder subsequently reported successful phone verification; the database confirmed one verified development proof. Real signup/passkeys/recovery and the persistent messaging agent are now implemented and tested locally. Native account/device flows, public iMessage delivery, Natural sandbox payments and hosted deployment remain unverified. Twilio is deferred.  
**Purpose:** The exact accounts and credentials needed to connect the implementation, in a practical order.

Local development uses an isolated payment simulator and needs no external account. Keep that mode separate from provider sandbox and production environments. Supplying keys does not itself enable real payments; each adapter must pass the applicable checks in the [verification register](verification-register.md).

## 1. What to set up first

| Priority | Account | What to collect | What it unlocks |
| --- | --- | --- | --- |
| Configured locally | OpenAI API Platform | Project API key with model access and API billing | Receipt interpretation evaluation |
| Configured locally | Sendblue | API key ID and API secret key; assigned messaging number if available | Real phone signup and configured messaging adapter; live callbacks still gated |
| Before real payments | Natural | Approved organization/account, sandbox access, sandbox provisioning API key, sandbox agent key, agent ID | Connect onboarding and payment integration testing |
| Deferred fallback | Twilio | No new purchase requested; existing credentials can remain configured | Alternative SMS verification if the Sendblue device/recovery spike requires it |
| Before shared beta | Render and AWS | Workspace/repository access; AWS account with restricted storage access | Shared staging, workers, managed PostgreSQL, private receipts |

Store secret values in the local ignored environment file or the appropriate hosting secret settings. Report only “configured” and any nonsecret account/setup status in chat. Do not paste keys into this document, a commit, a screenshot, or a message.

## 2. Natural: payment accounts and sandbox

### Founder setup

1. Start from [Natural](https://www.natural.com/) and create the organization's account. Complete the requested organization onboarding.
2. Ask Natural to confirm that our US consumer P2P reimbursement product is approved for Connect, including individual consumers, bank-funded repayment, receiving funds, withdrawals, commercial fees, and the intended embedded onboarding experience. A successful API login alone does not establish program eligibility.
3. In the dashboard's bottom-left account menu, turn on **Sandbox**. Natural documents a separate sandbox API origin and environment-specific credentials. [Sandbox setup](https://docs.natural.com/api-reference/sandbox/overview)
4. Create a sandbox **party API key** for provisioning. Label it `Tallie sandbox provisioning`. This is our administrative setup credential; it is not the ordinary agent runtime key. Scope it to the provisioning actions we actually use. Natural shows the secret once. [Authentication and API keys](https://docs.natural.com/api-reference/authentication)
5. Create the platform's sandbox agent, then create an **agent key** bound to it. Label the agent `Tallie sandbox`. Save its agent ID and key. The key is a different credential type with Natural's fixed agent policy. [Agent keys](https://docs.natural.com/api-reference/agent-keys/create-agent-key), [credential roles](https://docs.natural.com/api-reference/authentication)

### Proposed configuration

These are our proposed application environment names, **not yet a claim that the adapter reads them**:

| Name | Value kind | Destination |
| --- | --- | --- |
| `NATURAL_API_BASE_URL` | Sandbox origin: `https://api.sandbox.natural.com` | Payment adapter |
| `NATURAL_PROVISIONING_API_KEY` | Secret, sandbox party API key; prefix `sk_ntl_sandbox_` | Provisioning process only |
| `NATURAL_AGENT_KEY` | Secret, sandbox agent credential; prefix `ak_ntl_sandbox_` | Core payment worker |
| `NATURAL_AGENT_ID` | Nonsecret identifier of our provisioned agent | Adapter configuration |
| `NATURAL_WEBHOOK_SIGNING_SECRET` | Secret returned when we create the webhook | Natural webhook ingress |

The key prefixes and base URL are documented by Natural. [Authentication](https://docs.natural.com/api-reference/authentication)

**We will create later:** the HTTPS webhook endpoint and its subscription. The create response provides `signingSecret`; subscribe to relevant events from both `own` and `connected` sources. Keep the provisioning key out of routine web/payment processes. [Create webhook](https://docs.natural.com/api-reference/webhooks/create-webhook)

**No key to obtain:** `X-Instance-ID` is generated by our application for an operation/run and kept stable across retries. It is required for agent-attributed money commands, but it is not a credential. [Instance attribution](https://docs.natural.com/api-reference/authentication)

**First integration checks:** identify the authenticated actor, create/accept a targeted sandbox customer invitation, verify customer/agent binding, create a request, fulfill once, retry safely, and reconcile events. Sandbox's documented immediate settlement does not test production bank delays or return behavior. [Sandbox behavior](https://docs.natural.com/api-reference/sandbox/overview)

## 3. Twilio: signup verification

**September 26 decision:** defer Twilio setup and funding. The founder proposed Sendblue for verification; ADR-019 selects it for the next phone-proof spike. The following Twilio instructions are retained as a possible fallback, not a current prerequisite.

### Founder setup

1. Create a [Twilio account](https://www.twilio.com/). Keep a separate application project/subaccount where appropriate to the account setup.
2. Copy the **Account SID** from the console; it starts with `AC`.
3. Open **Settings → Account settings → API keys & auth tokens**, select the intended region, and create an application key. Prefer a Restricted key with the necessary Verify actions; a Standard key is acceptable for a controlled initial integration test if those permissions need validation. Save the key SID and one-time secret. [Console instructions](https://www.twilio.com/docs/iam/api-keys/keys-in-console)
4. Check whether **Identity → Verify → Overview → Try out Verify** is available to the account. Twilio's public docs still describe a trial, but on September 26 the founder reported that Verify is unavailable on their free trial. Do not promise trial availability based on the documentation alone. If a trial service is exposed, copy its `VA…` service SID from the sample request. If the console requires an upgrade, use its Pay as you go upgrade flow and create a service named `Tallie development` when access is enabled. A Verify Service groups verification configuration; it is not a phone number. [Documented trial flow](https://www.twilio.com/docs/usage/trials/try-out-verify), [account upgrade](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account), [Verify services](https://www.twilio.com/docs/verify/api/service)
5. Use one consenting verified test recipient initially. The documented trial allows up to five verified recipients and lasts 30 days, where available. Twilio documents customer-profile approval after upgrade before unrestricted SMS/Voice OTP recipients; payment alone must not be treated as proof that account restrictions are removed. [Verify access conditions](https://www.twilio.com/docs/usage/trials/try-out-verify)

**Cost reference, checked September 26:** published US SMS Verify pricing is $0.05 per successful verification plus $0.0083 per SMS. For 100 successful verifications with exactly one SMS each, the calculated usage cost is $5.83 before taxes, extra attempts or other charges. Initial account funding is separate; use the amount shown by the account's upgrade flow rather than assuming a minimum deposit. [Current pricing](https://www.twilio.com/en-us/verify/pricing)

| Proposed name | Value |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Account identifier, `AC…` |
| `TWILIO_API_KEY_SID` | Application API key identifier, `SK…` |
| `TWILIO_API_KEY_SECRET` | Secret displayed when that key is created |
| `TWILIO_VERIFY_SERVICE_SID` | Verify service identifier, `VA…` |

Verify supports API key SID/secret authentication. We will use that application credential instead of distributing the account's master Auth Token. API secrets are displayed only at creation. [Verify authentication](https://www.twilio.com/docs/verify/api), [key resource](https://www.twilio.com/docs/iam/api-keys/key-resource-v1)

**First integration checks:** one consenting test phone, correct/wrong/expired codes, resend limits, replay rejection, delivery failure, and restricted account recovery. Successful OTP verification proves access to a number; our existing-account recovery checks still apply.

## 4. Sendblue: iMessage and channel connection

### Founder setup

1. Create a [Sendblue account](https://dashboard.sendblue.com/). Its setup assigns a number and verifies an initial contact. A shared development line is suitable for an early device test; ask for a dedicated persistent number before a real beta. Shared-line outbound contacts must first be verified. [Getting started](https://docs.sendblue.com/getting-started/)
2. In the dashboard, save **both** the API key ID and API secret key. These map to `SB-API-KEY-ID` and `SB-API-SECRET-KEY` request headers. Calls originate from our backend. [Credentials](https://docs.sendblue.com/getting-started/credentials/)
3. Record the assigned messaging number in E.164 format, such as a `+1` US number, if one is available. The two API credentials are sufficient to begin checking Verify access; its default shared verification pool supplies the challenge destination. An ordinary messaging sender and a verification destination are not necessarily the same number. Ask Sendblue to approve the consumer payment-request use case and confirm dedicated-number, consent, media retention, delivery, and SMS fallback behavior before the beta.

| Application name | Value / when obtained |
| --- | --- |
| `SENDBLUE_API_KEY_ID` | API key ID from the dashboard |
| `SENDBLUE_API_SECRET_KEY` | API secret from the dashboard |
| `SENDBLUE_FROM_NUMBER` | Provider-assigned messaging number |
| `SENDBLUE_MESSAGE_WEBHOOK_SECRET` | Generated/configured when ordinary message callbacks are registered |
| `SENDBLUE_VERIFY_SERVICE_SID` | ID returned when we create the Verify service; `SV…`; no separate key to obtain |
| `SENDBLUE_VERIFY_WEBHOOK_SECRET` | Returned when the Verify webhook is registered; not wired yet |
| `SENDBLUE_PHONE_ENCRYPTION_KEY` | Generated locally, independent 32-byte key encoded as 64 hex characters; wired for encrypted development challenges |

**We will configure later:** ordinary incoming/status callbacks and a separate Verify callback after staging has HTTPS URLs. Ordinary callbacks carry a configured `sb-signing-secret` header. Verify callbacks use a timestamped HMAC signature and their own returned secret; they need a separate verifier. [Webhook security](https://docs.sendblue.com/security/), [Verify service and callbacks](https://docs.sendblue.com/api-v2/verify/)

**Preferred next spike:** use Sendblue Verify as phone-possession proof for signup as well as channel connection, with separate challenge purposes. It uses the same API key ID and secret as messaging. Proposed mobile UX: Continue with Messages → open the provider's prefilled message → user taps Send → return to Tallie, which checks approval on the backend. Opening a message composer is not verification. We create the `SV…` service and later register the Verify webhook; the founder need only provide the two API credentials initially. [Sendblue verification flow](https://docs.sendblue.com/api-v2/verify/)

Each challenge must bind to a server-created signup/guest transaction or existing authenticated user, expected phone, session nonce, purpose and expiry. Consume a server-confirmed approval once. Existing-account access, recovery, messaging consent and payment approval remain separate. The development adapter now enforces these bindings for purpose `connect_test`; it grants no login or payment authority. Better Auth signup/passkey/recovery integration remains unimplemented. See [Sendblue integration](sendblue-integration.md) for exact API behavior and remaining device gates.

**Device and line gates:** verify actual iPhone behavior and independently establish Android/SMS support before selecting a sole phone-proof path. A `sms:` deep link does not itself establish provider support for SMS verification. Account-assigned lines can be preferred with `use_customer_lines`, but documented shared-pool fallback means the verification thread is not guaranteed to be the ongoing Tallie agent thread. [Verify routing](https://docs.sendblue.com/api-v2/verify/)

**First integration checks:** our test phone sends a synthetic receipt, receives a safe web link, verifies its channel binding, and exercises duplicate/invalid callbacks and media expiry. Obtain test recipients' consent before sending messages.

## 5. OpenAI: receipt interpretation

1. Sign in to the [OpenAI API Platform](https://platform.openai.com/), create/select a `Tallie development` project, and configure API billing as required by the account. Create a project API key from [API keys](https://platform.openai.com/api-keys). The official quickstart uses `OPENAI_API_KEY`. [Quickstart](https://developers.openai.com/api/docs/quickstart)
2. Give the project access to the model used by the receipt evaluation. The final model is selected by receipt accuracy, latency, and cost measurements; there is no model purchase decision to make now.
3. Set a modest development budget/limits, alerts, and an expiration/rotation plan. Use a separate project and credential for production. [Production setup](https://developers.openai.com/api/docs/guides/production-best-practices)

| Proposed name | Value |
| --- | --- |
| `OPENAI_API_KEY` | Project API key, available only to the isolated receipt worker |
| `RECEIPT_MODEL` | Model identifier chosen and pinned by evaluation |

**Implemented local flow:** authenticated/session-bound upload → durable job → isolated decoder → structured OpenAI proposal → editable review → manual expense publication. Pinned starting model: `gpt-4.1-mini-2025-04-14`. Three synthetic live checks passed, including unknown tip and printed instruction handling; this is not a broad accuracy claim. Photos remain private and expire after 24 hours. No participant-visible image derivative exists. See [receipt evaluation](receipt-evaluation.md).

## 6. Hosting and private storage: later

### Render

Create a [Render](https://render.com/) workspace and connect the repository when shared staging is useful. We will provision the web service, core worker, separate receipt worker, and managed PostgreSQL. Configure each service's secrets in Render; Git-backed deployment does not require sharing the founder's login or issuing a general Render API key. [Deployment setup](https://render.com/docs/deploys), [environment secrets](https://render.com/docs/configure-environment-variables)

### AWS S3

Create an AWS account and enable strong account access. We will create a private bucket with public access blocked, appropriate encryption, and distinct original/derived receipt permissions. Record the bucket name and region. [S3 security](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)

Prefer temporary role-based credentials where the hosting integration supports them. If a scoped access key is necessary for the selected Render-to-S3 setup, create a dedicated restricted application identity, separate per environment/role, and rotate it. Never provide AWS root access keys. The exact hosting identity arrangement needs an implementation check. [AWS credential guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

Proposed storage settings: `AWS_REGION`, `RECEIPTS_BUCKET`, and the role/credential configuration selected in that check. AWS access keys are not required to build the current manual-expense slice.

## 7. Secrets we generate ourselves

- **Better Auth:** no separate paid service account is required for the selected self-hosted library. Generate a high-entropy `BETTER_AUTH_SECRET` and configure `BETTER_AUTH_URL` when integrating real auth. The library requires at least 32 characters and documents `openssl rand -base64 32`. [Installation](https://better-auth.com/docs/installation)
- **App security keys:** independent keys for invitation digests, phone lookup HMAC, and contact-field encryption are generated during their implementation. They must not reuse provider, auth, or webhook secrets.
- **Database credentials:** local disposable credentials already come from the development setup; staging credentials come from its database. Runtime and migration roles remain separate.
- **Venmo:** the selected fallback needs a requester-confirmed receiving username/profile and real-device link testing. It does not require a new Venmo developer API credential. Our app confirms external repayment manually.

## 8. Integration handoff

When an account is ready, record its environment and “credentials configured,” without values. We will then:

1. Wire only that provider's environment schema and fail closed if the configuration is incomplete.
2. Check identity and environment using a read-only call before any test mutation.
3. Run the smallest consenting/synthetic sandbox or device flow.
4. Add dated evidence to the verification register, keeping sandbox behavior distinct from live behavior.
5. Enable the adapter only after its specific gate passes; keep the simulator available for isolated tests.

**Current status:** root `.env.example` lists the wired receipt and phone-test settings. `npm run dev` / `npm run start` distribute them by role using `scripts/run-service.mjs`. Adding these optional credentials enables real AI interpretation and user-initiated phone proof; money remains simulated. Natural, ordinary Sendblue message/webhook settings, hosting, and Twilio settings above remain proposed/unwired unless explicitly stated otherwise.


## September 26 implementation update — accounts and deployment

The root `.env` is already populated for local receipt extraction and Sendblue verification. No additional provider keys are needed to test the new local signup. `npm run setup` generates missing local application secrets; it preserves existing values.

| Configuration | Role / handling |
| --- | --- |
| `BETTER_AUTH_SECRET` | Web session signing; generated locally; use a separate stable hosted secret |
| `IDENTITY_ENCRYPTION_KEY` | 64 hexadecimal characters; encrypted identity/contact information and phone lookup; web + messaging worker |
| `MESSAGING_ENCRYPTION_KEY` | Independent 64-character hex key for encrypted messages/drafts/outbox; web + messaging worker |
| `SENDBLUE_FROM_NUMBER` | Assigned messaging line in E.164; the configured US development line was normalized without making a provider call |
| `SENDBLUE_MESSAGE_WEBHOOK_SECRET` | Generated callback header secret; web + messaging worker; not configured at the provider yet |
| `MESSAGING_SEND_ENABLED` | Defaults to false. Keep disabled until HTTPS callback, line-routing and consenting-device checks |
| `APP_MODE=beta` | Hosted real-account mode; blocks demo entry and simulated payment APIs |
| `APP_ORIGIN` | Exact stable HTTPS app origin; passkeys are bound to its relying-party domain |
| `APP_HOST=0.0.0.0` | Hosted web listen address; local default remains localhost |
| `RECEIPT_STORAGE_DRIVER=s3` | Required for the prepared separate hosted receipt/web/message roles |
| `RECEIPTS_BUCKET`, `AWS_REGION` | Shared private receipt bucket/region; optional `RECEIPTS_BUCKET_OWNER` enforces expected account |
| AWS credentials | Separate limited IAM credentials per web, receipt and messaging role; never public browser variables |

The founder requested deployment preparation and has no hosting/domain yet. Docker/Render files are prepared, with private PostgreSQL and private S3 storage. Nothing has been provisioned. Follow [deployment](deployment.md) and [storage/IAM setup](deployment-storage.md) when choosing the public address and accounts. A custom domain is useful but an initial stable provider HTTPS hostname can work; pick the relying-party origin before enrolling external testers.

Signup is now phone proof → name → passkey. Recovery is a saved code plus fresh same-phone proof; this is different from the previous development-only proof. See [identity](identity-integration.md), [friends/invitations](social-integration.md), and [message integration](messaging-integration.md). Natural account creation, transfer approval/execution, and Venmo fallback remain separate work.
