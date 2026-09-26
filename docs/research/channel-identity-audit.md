# Identity, messaging, invitation, and receipt audit

**Checked:** September 25, 2026. **Purpose:** research inputs for the living technical design. This is not an implementation or a production certification. Public documentation was checked; no provider account, credentials, real device integration, or live payment was available for testing. Proposed controls below are engineering decisions rather than claims about provider behavior.

## 1. Verified integration facts

| Area | Finding | Consequence | Primary source |
|---|---|---|---|
| Ordinary message webhook authentication | Sendblue documents a configured secret carried in `sb-signing-secret`. Its security page describes matching this header. | Constant-time comparison against a required secret; do not describe it as a timestamped HMAC signature. Rotate separate endpoint secrets and redact headers. | [Sendblue security](https://docs.sendblue.com/security/) |
| Verify webhook authentication | Verify documents `X-Sendblue-Signature: t=...,v1=...`, HMAC SHA-256 over timestamp, period, and raw request body. It recommends a five-minute replay window. | Separate verifier from ordinary message hooks. Verify raw bytes before parsing and deduplicate successful challenges. | [Sendblue Verify](https://docs.sendblue.com/api-v2/verify/) |
| Verification binding | Sendblue Verify challenges an expected E.164 number. A code from a different number does not approve that verification. Status can be fetched with server credentials. | Match pending challenge, provider service, expected number, account/session, expiry, and purpose. A webhook alone must not cause arbitrary account binding. | [Sendblue Verify](https://docs.sendblue.com/api-v2/verify/) |
| Delivery retries | Sendblue says hooks can duplicate, retry up to three times after server failures, and wait up to 45 seconds for a response. | Authenticate, durably insert an inbox record, return promptly; worker performs expensive work. Outage recovery needs polling/reconciliation where supported. | [Sendblue webhooks](https://docs.sendblue.com/getting-started/webhooks/) |
| Sending | Ordinary sends expose `from_number`, recipient, content, media, and status callback. The reviewed schema does not establish ordinary-send idempotency. The same sender line should continue to be used for each contact. | Stable sender-line affinity and local outbox dedup. A lost response after submission is delivery-unknown; do not blindly submit another send. | [Send endpoint](https://docs.sendblue.com/api/resources/messages/methods/send), [sending guide](https://docs.sendblue.com/getting-started/sending-messages/) |
| Different endpoint capability | App Card updates explicitly expose `idempotency_key`. | This does not prove ordinary text sends accept or honor that key. | [App Card update](https://docs.sendblue.com/api/resources/messages/methods/update_app_card/) |
| Status semantics | Sent and delivered are different; SMS may terminate at sent. Ordinary messages may automatically downgrade to SMS, and the guide says global downgrade disabling is unavailable. | All P0 text and links must be suitable for SMS. No claim that all app messages remain encrypted iMessage. Delivery status does not imply read or payment. | [Sending guide](https://docs.sendblue.com/getting-started/sending-messages/) |
| Media | Incoming events expose media URL, message handle, sender, receiving line, group ID and participants. Inbound media URLs expire after 30 days. | Copy supported media promptly through a restricted fetcher; retain only under our own explicit policy. Incoming participants are not the user's address book. | [Receiving guide](https://docs.sendblue.com/getting-started/receiving-messages/) |
| Consent | Sendblue terms require explicit opt-in before initiating engagement; its security page describes stop/start processing. Terms also disclaim communication privacy guarantees. | Store evidence of channel consent separately from signup and money approval. Keep originals, bank details and identity documents out of outgoing messages. | [Terms §13](https://www.sendblue.com/terms-of-service), [security](https://docs.sendblue.com/security/) |
| Contacts | Browser Contact Picker is limited/experimental. | Manual E.164 entry, recents, verified app relationships, and personal sharing are baseline. Native address-book access is later. | [MDN Contact Picker](https://developer.mozilla.org/en-US/docs/Web/API/ContactsManager), [compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/ContactsManager.json) |
| Venmo destination | Official consumer docs support sharing a personal profile/QR destination. Reviewed docs did not establish a supported third-party personal-payment URL contract with amount and note prefill. | Keep the requested prefilled handoff behind empirical device verification, with a profile destination and explicit copy fallback. | [Venmo personal QR](https://help.venmo.com/cs/articles/personal-qr-codes-on-venmo-faq-vhel316) |
| Venmo amount evidence | Preset amount QR codes are documented for business profiles. | Do not generalize merchant/business behavior to personal repayments. | [Venmo business QR](https://help.venmo.com/cs/articles/qr-codes-for-business-profiles-vhel305) |
| Venmo completion | No supported personal-link completion API was verified. The previously known `/docs/webhooks` URL now redirects to business profiles when opened. | Return-to-browser, screenshots, or link clicks are not settlement proof. Use payer report plus requester confirmation. | [Observed former docs URL](https://venmo.com/docs/webhooks), [current destination](https://venmo.com/business/profiles) |
| Venmo note privacy | Payment visibility can expose names and note depending on the user's settings. | Use a short nonsensitive purpose. Never put receipt URLs, invitation secrets, phone numbers, or internal authorization tokens in notes. | [Venmo privacy](https://help.venmo.com/cs/articles/manage-your-venmo-privacy-settings-vhel351) |

**Documentation drift:** Sendblue guides and generated API reference have some differing details (for example account-level hooks versus receive-hook line filters). Capture actual sandbox fixtures and pin the adapter contract before implementing assumptions about optional fields or line scoping. Do not weaken verification when a fixture disagrees; resolve the contract.

## 2. Proposed identity model

- Use an immutable internal user ID. A phone number is a revocable verified credential/address with verification epoch, not the account primary key and not a payee identity.
- A payment destination is the specific server-bound Natural customer/party and wallet permitted for that user. Client phone numbers, names, agent names, or app aliases never select an arbitrary payment account directly.
- Store canonical E.164 encrypted and a keyed HMAC for exact lookup; plain hashes are guessable over the phone-number space. Preserve only minimally necessary display suffixes. Apply rate limits and generic errors to prevent user enumeration.
- Better Auth phone and passkey integration is the root design direction. Use an auth-owned recent assurance record; a chat inbound number cannot mint a browser session or bypass passkey/risk requirements.
- Keep app identity, messaging opt-in, Natural permission state, and individual transaction approval as distinct records. None automatically implies the others.
- Require fresh assurance for phone changes, account recovery, payee/bank destination changes, and other sensitive actions. Revoke existing sessions/channels when credentials are recovered or reassigned. A new owner verifying an old phone must never inherit historic user access or reroute confirmed aliases.
- Passkeys improve resistance to stolen/reassigned phone numbers. Phone OTP is the low-friction onboarding path, but OTP-only account recovery must not immediately restore unrestricted financial authority. Document the precise recovery hold/reverification policy before real-money launch.

### Guest access and eventual signup

Keep guest verification separate from account signup. A guest is a scoped principal, not an automatically created permanent account.

1. Generate a high-entropy, revocable invitation; retain only its hash. It points to one obligation and intended identity. GET shows a limited invitation and does not claim, cancel, pay, or consume anything.
2. Start an explicit challenge against the server-held intended phone. The browser must not choose an arbitrary phone and thereby become the intended participant.
3. Successful verification creates a proof record bound to invite, expected phone, provider challenge, purpose, and expiry. Issuing a guest session consumes that proof atomically.
4. Issue an HttpOnly, Secure, host-only guest cookie in a separate namespace. Proposed expiry: 30 minutes idle, 24 hours absolute. Its scopes are limited to viewing the authorized expense and reporting the relevant external payment. It cannot call account, wallet, contacts, or Natural APIs.
5. Access checks require the current invitation/participant ACL and revocation state, not merely the cookie. Financial/report mutations also require the latest obligation version. A session does not make a stale amount authoritative.
6. On explicit Join plus terms acceptance, P0 performs a fresh normal account signup verification while preserving the request. This adds a second verification only for guests who later choose to join and avoids unsupported auth-session promotion. Root selected Better Auth's documented server-only `consumePhoneNumberOTP` for the scoped guest check, subject to the implementation spike verifying its plugin interaction with Twilio. A future proof bridge requires a documented, tested server-side integration. Never let a client set `phoneVerified` or inject an arbitrary account ID. Never send a consumed Twilio OTP through another validation flow expecting it to work.
7. Convert memberships transactionally to the resulting immutable user ID; invalidate or downgrade redundant guest capabilities. Do not merge different accounts because two untrusted names match.

**Name-only invitation:** if the sender has not supplied a number or known user, verifying any phone proves possession of that phone only. Require sender approval of the claimant before revealing the full receipt or binding future requests. A first-click claim must not reveal all participants' shares to anyone holding a forwarded link. A primary sender-provided intended phone avoids this extra step.

## 3. Preview-safe links and external handoff

- GET and HEAD remain side-effect free. Link unfurlers receive generic title/image, never receipt pixels or other participants' information. Do not count preview fetches as user views or approvals.
- Invitation routes use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, no third-party scripts, and analytics that redact path tokens. After an explicit token exchange, remove secrets from visible history when practical. Opening a link is not a financial authorization.
- Validate redirect destinations by exact internal route/provider allowlist. Do not accept a client-supplied Venmo URL without strict scheme/host/path validation; store a confirmed handle/profile reference and derive the destination server-side.
- The requester confirms ownership of a Venmo handle; this is not provider-verified ownership. Show handle, amount and note at handoff. Snapshot its version on the external attempt. A change of handle invalidates stale handoff tokens/reviews.
- POST to begin the Venmo path obtains the obligation lock, checks current state, and confirms any open Natural request is canceled before returning an external destination. PROCESSING, unknown payment outcome, or unresolved provider cancellation blocks a competing payment path.
- A Venmo URL remains usable outside our app after it has been displayed. Therefore exactly-once settlement across Natural and arbitrary external Venmo actions cannot be guaranteed. Our controls prevent conflicting app commands and make manual reconciliation explicit.
- A payer report freezes normal collection/reminders while the requester confirms or disputes. A browser return alone does not change financial state. If someone abandons handoff and wants to use Natural, obtain a current explicit statement that they did not pay externally and present current state; retain the attempted handoff in the audit trail.

## 4. Message processing and adapter boundaries

Suggested interface: `verifyWebhook(rawBytes, headers)`, `normalizeInbound`, `sendText`, `getMessage`, `listMessages`, `startChannelVerification`, `getChannelVerification`. Feature flags advertise signed-event support, ordinary-send idempotency, retrievable history, attachment types, and observed service behavior. Capability flags reflect tested provider contracts, never marketing assumptions.

- Durable inbound inbox uniqueness: provider account plus incoming message handle. Reject unexpected receiving lines, outbound events arriving on command paths, malformed identifiers and unsupported event types. Ignore location/call data rather than retaining unnecessary PII.
- Before a chat-originated command publishes or changes a financial request, retrieve the provider message by its authenticated server API and compare message handle, sender, receiving line and content. This narrows the trust placed in the ordinary static-secret webhook channel. A mismatch or unavailable canonical message holds the command; it cannot bypass identity checks or create money movement.
- Outbound status events repeat for the same message handle. Do **not** globally deduplicate every callback solely by handle. Use event ID when provided, otherwise handle + status + provider update time + payload hash, then project the latest reconciled state.
- Use a per-conversation queue and optimistic draft version. An inline reply can identify a draft only after validating that the parent belongs to the same authenticated private conversation. Ambiguous references ask a short question.
- Multi-person receipt splitting remains a private conversation feature. Group-chat membership does not establish account relationships, consent or receipt permissions. P0 should decline processing group-chat financial content with a generic private-conversation direction, without echoing any financial details.
- Deduplicate outgoing business notifications by semantic event and recipient. If sending timed out with no handle, mark delivery unknown. A provider-history lookup may locate the attempt; matching content/time alone is insufficient if ambiguous. A support-authorized resend may duplicate a message, but must never duplicate its underlying financial operation.
- Recheck current opt-out state immediately before sending, including already queued notifications. Classify STOP before LLM intent parsing; suppress channel sends immediately. Do not rotate phone lines to evade an opt-out or delivery restriction.
- After message delivery failures, the web app remains authoritative. Delivery retries cannot mutate the obligation or recreate a payment request. A sender sees request creation and notification delivery as separate states.

## 5. Receipt ingestion and privacy controls

Two paths—presigned authenticated web upload and authenticated provider event—converge on one quarantined attachment pipeline.

- Fetch provider media server-side through an allowlisted HTTPS fetcher with DNS/IP and redirect checks, timeouts and byte caps. Block loopback/private/link-local destinations, metadata services, URL userinfo, and unsupported schemes. Do not let arbitrary user text supply a fetch URL.
- Decode only permitted image formats in an isolated worker with byte/pixel/time/memory limits. Sniff file content, reject SVG/HTML and unsupported documents, normalize orientation and re-encode pixels. Strip EXIF/GPS and other metadata. Test actual HEIC photographs before claiming support.
- Store original and shareable derivative under separate private objects/permissions. Original is restricted to uploader and audited support when justified. Participant rendering uses only the redacted derivative and normalized structured receipt, through short-lived authorized URLs or an authenticated proxy.
- Redaction must cover sensitive pixels **and** extracted text, including payment-card identifiers, customer contact data, signatures, loyalty identifiers and machine-readable codes that disclose private data. Keep the merchant, item, tax/tip and total information needed for transparent splits.
- Automated masks need deterministic detector rules and adversarial fixtures. If the redaction result is uncertain, withhold the image and ask the sender to review masks; do not label an unchecked original as redacted. Store redaction version, source hash and derivative hash.
- OCR/LLM input is untrusted evidence, never instructions. No model receives provider credentials or arbitrary network tools. Model output is a schema-validated proposal; deterministic code owns amounts, access control and all state transitions.
- Propose seven-day unauthenticated draft expiry consistent with the PRD. Agree final original/derivative retention and provider deletion behavior before real receipts. Do not claim deletion from Sendblue merely because our object was deleted.

## 6. Required verification before release

| Test | Expected result |
|---|---|
| Modified Verify raw bytes, wrong secret, malformed hex, old/future timestamp, replay | No challenge/account binding; logs contain neither OTP nor secret |
| Ordinary message hook without correct configured secret | Rejected; not parsed as a command |
| Valid inbound delivered twice; outbound SENT then DELIVERED | One command; both delivery transitions retained |
| Crash after inbox commit but before queue acknowledgement | Worker recovers once through durable inbox |
| Provider accepts outgoing send but response is lost | Delivery unknown, no blind duplicate; financial state unchanged |
| STOP arrives while reminders are queued | Queued sends suppressed before dispatch |
| Reused expired challenge; guest cookie on wallet endpoint | Access denied |
| Forwarded invite, wrong phone, name-only first claimant | No private receipt or participant disclosure |
| User changes/recycles phone; old aliases and history | No rerouting or historic access inheritance |
| GET/HEAD/unfurl all invitation/payment/Venmo routes | No claim, cancellation, payment or external-attempt mutation |
| Venmo handoff races Natural payment or request revision | One allowed app path; pending/unknown state blocks handoff |
| Return from Venmo without paying | No settlement; reporter/requester confirmations remain separate |
| HEIC, oversized dimensions, malformed/polyglot image, hostile URL | Bounded processing or clear rejection; no SSRF or unsafe public upload |
| Card digits/phone/signature/barcode in image and OCR | Redacted pixels and text before participant sharing |
| iPhone Safari, in-app browsers, Android/desktop, Venmo absent/present | Exact tested prefill or visible profile/copy fallback, never false completion |

Record provider versions, device/browser versions, sanitized fixtures, observations and last verification dates in the integration register. Re-run only impacted fixtures when contracts or adapters change.
