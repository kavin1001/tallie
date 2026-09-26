# Sendblue development phone proof

Updated September 26, 2026. This is a development integration, separate from signup and financial identity.

## Evidence

- **Actual provider configuration:** authenticated service listing returned HTTP 200. Created one `Tallie development` Verify service successfully, with six-character codes and a 300-second lifetime. The identifier is stored only in ignored local configuration.
- **No device verification yet:** no verification was created for the founder, no phone number was submitted, no outbound message was sent, and no webhook was registered during implementation. Completing a phone proof still requires the user to initiate it in Tallie and send the displayed code.
- **Implementation tests:** 24 tests passed: seven adapter/encryption tests and seventeen PostgreSQL integration tests, using synthetic phone numbers and a mocked provider. TypeScript checks passed for channels, web, database and core worker packages.
- **Public documentation:** Sendblue describes a reverse OTP flow, in which the user sends a code from the expected phone number. Recent approval lookups include the expected number; later terminal lookups can return a null number. [Verify documentation](https://docs.sendblue.com/api-v2/verify/).

## Local behavior

The profile flow asks for the user's phone number and explicitly starts a development test. Creating a challenge does not send an SMS to that phone. The browser receives a code and destination number, and a constructed `sms:` link. The user chooses whether to send the message. Actual iOS, macOS and Android behavior remains a device test gate.

| Endpoint | Input | Result |
|---|---|---|
| `GET /api/phone-verifications` | Authenticated demo session | Availability and that session's latest challenge |
| `POST /api/phone-verifications` | `{phone}` plus `Idempotency-Key` | New challenge, or the same challenge for the same intent |
| `POST /api/phone-verifications/:id/check` | `{}` | Checks only the provider identifier already stored for this session |
| `POST /api/phone-verifications/:id/cancel` | `{}` | Cancels local pending/creating evidence; no provider cancellation call |

All responses use the existing `{data}` envelope and `Cache-Control: private, no-store`. POSTs use the existing JSON/Origin/session boundary. All routes remain unavailable outside `APP_MODE=demo`.

Approval requires matching provider service ID, verification ID and exact canonical phone, while the local challenge and session are still current. A null phone on a terminal provider response results in `needs_retry`; it cannot authenticate the user. Expired or canceled evidence cannot be revived by a late approval. A unique claim is consumed atomically with the local verified state. It has the fixed purpose `connect_test` and grants no account, contact, invitation, payment or bank authority.

Retries retain their identity. The same key with another phone is rejected. Ambiguous provider creation is not automatically repeated; it leaves a failed local intent and any orphaned provider challenge expires. A new explicit attempt uses a new key. A new challenge cancels earlier pending challenges in that browser session.

## Privacy and resource limits

- Server-only API credentials; fixed provider origin, blocked redirects, ten-second timeout and bounded responses. Provider messages and error bodies are never returned to the browser or logged.
- Phone numbers and pending delivery codes use AES-256-GCM with random nonces, challenge/field associated data and a versioned envelope. A separately derived HMAC indexes phone rate limits. The browser sees a masked expected phone, while the provider destination number and code are intentionally visible only to the owning session.
- Terminal transitions erase phone/code ciphertext. The core worker also erases expired abandoned challenges on startup and every sixty seconds while healthy, without provider credentials or encryption keys. A new challenge additionally runs opportunistic cleanup. The five-minute acceptance deadline is enforced independently of cleanup timing.
- At most five new intents matching the current session or phone in fifteen minutes, and one hundred total intents per hour in this development database. Database advisory locking makes cross-session limit checks atomic. Idempotent replay does not consume another quota unit.
- Provider polling is reserved at most once per three seconds per challenge, outside the database transaction. The UI should keep only one poll in flight and stop on a terminal state.
- The input format permits `+1` North American Numbering Plan numbers; format validation is not proof of a US resident, eligible customer or financial identity.

## Remaining gates

Complete a user-initiated proof on real devices, observe provider failure and expiry behavior, establish production abuse controls and key rotation, define metadata retention, configure authenticated webhooks on a public HTTPS endpoint, and implement a reviewed bridge to real account/session recovery. No demo proof may be promoted directly into that future identity system.
