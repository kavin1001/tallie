# Persistent identity integration

**Updated:** September 26, 2026. **Evidence:** implemented and tested locally against PostgreSQL with mocked Sendblue responses and cryptographically valid synthetic WebAuthn ceremonies. Founder separately reports that the earlier development Sendblue phone test completed on their device. That report does not verify the new signup/passkey flow on a real device.

## Boundaries

**Temporary preview exception:** ADR-026 permits phone-only signup/sign-in for explicitly marked manual-split demo accounts. The strong-account rules below otherwise remain unchanged.

Persistent accounts live in `auth_user`; they never inherit demo people, sessions, receipts, proofs, or payment authority. Natural account setup and all money movement remain disabled for these accounts.

Better Auth **1.7.6** manages signed HttpOnly session cookies and its session/passkey surfaces. The official `@better-auth/passkey` **1.7.6** plugin uses SimpleWebAuthn for cryptographic verification. Tallie's reverse-OTP bridge atomically writes a new identity, encrypted phone binding, restricted session and consumed proof in PostgreSQL, then asks Better Auth to set its normal session cookie. A response retry recovers exactly the original session; it cannot mint a new session after logout. Once consumed, only the encrypted completion result is retained for up to 30 minutes for the original signup browser. This does not extend the five-minute unconsumed provider proof or any session authority.

Phone proof alone never logs into an existing account. A new account's session has `assurance_kind=onboarding` and cannot read private social/receipt data. Successful passkey persistence upgrades only the enrolling session. Returning users sign in with their passkey. Recovery requires both a fresh, correctly bound Sendblue phone proof and an unused recovery code.

## Signup and recovery

1. `GET /api/identity/state` creates an opaque anonymous signup browser cookie if needed.
2. `POST /api/identity/signup/start` accepts `{phone}` and an `Idempotency-Key`. It creates a five-minute provider challenge bound to the browser hash, expected phone, purpose, service and verification SID.
3. The user explicitly sends the prepared message. `POST /api/identity/signup/check` accepts `{challengeId}` and checks Sendblue server to server. A null or mismatched provider phone fails closed. Opening Messages is not proof.
4. `POST /api/identity/signup/complete` accepts `{challengeId,name}`. It consumes the proof and creates a restricted account/session. Concurrent retries share one result.
5. The official client registers a discoverable passkey. Both registration and authentication require verified user verification (device PIN/biometrics), a fixed relying-party ID and origin, and a single-use ceremony challenge. The upstream plugin internally permits non-UV assertions; Tallie explicitly rejects those through its verified-result hooks.
6. An established account can request eight replacement recovery codes with `POST /api/identity/recovery-codes`. Each contains 128 bits of random entropy; only a digest is persisted. The response shows the codes once. Regeneration invalidates the previous set and requires assurance within 15 minutes.
7. `POST /api/identity/recovery/complete` accepts `{challengeId,recoveryCode}`. Redemption is atomic, consumes one code, revokes existing sessions, and creates a recovery-assured session. Five incorrect attempts lock that proof; creating further proofs is independently rate limited.

An interrupted first enrollment can resume with **both** its original restricted session and a fresh phone proof. A different browser cannot use a recycled number to reclaim even an account that has not enrolled a passkey. If every factor and the original enrollment session are lost, an approved support recovery process is still required; none is implemented.

### Interrupted signup UI

On initial load, the client resumes an active signup challenge or unfinished account from server state. An unconsumed verified proof returns to the name form; a restricted session returns to passkey enrollment while its existing ten-minute enrollment window is current. The account DTO exposes `enrollmentExpiresAt`, derived from the same deadline used by registration authorization. After expiry, the UI asks for a fresh phone proof and preserves the saved name. Active renewed proofs take precedence over the older session after reload.

Back leaves the signup screen without revoking the restricted session; the landing action becomes **Finish setting up**. Explicit sign-out from an established account retains its existing revocation behavior. Unconsumed proof expiry returns to phone entry, and a registration freshness rejection gives a direct re-verification path. These changes do not lengthen proof/session authority or grant private access before passkey enrollment.

The first live retry confirmed phone proof but exposed a draft whose session had already been lost before this repair. Read-only account metadata confirmed it had no credentials or product activity. The founder subsequently approved a narrowly scoped reset of that empty draft; no established-account recovery override or restored session token was introduced. Such a reset must recheck credentials and all account references in the same short transaction, preserve historical signup/rate-limit evidence, and refuse a changed or non-empty account. It does not establish a recovery policy for accounts with activity.

## Temporary phone-only demo

Migration012 adds `auth_user.phone_demo` (false by default) and distinct `phone_demo` session assurance. `phoneDemoEnabled()` requires `IDENTITY_PHONE_DEMO_ENABLED=true`, `APP_PREVIEW_MODE=true` and `APP_MODE=beta`. Only the `web-preview` launcher forwards the identity flag and injects the preview marker; it also keeps receipts/messages disabled. The state endpoint reports the authentication mode.

`POST /api/identity/phone-demo/complete` accepts a challenge UUID and optional name. Existing browser, phone, purpose, expiry and one-use proof checks still apply. A new number receives `NAME_REQUIRED` without consuming the proof; submitting a name creates a marked account. Returning marked accounts retain their identity/name. Unmarked accounts and existing credentials are refused. Exact retries return the same active session; canonical state retires cached completion after logout. Sessions use Better Auth's normal 30-day rolling policy.

Demo assurance permits manual-split collaboration only while enabled. Social mutations lock account/session/phone binding and reject passkey evidence. Recent-security, channel and receipt-command guards remain strong-only; hosted receipt reads and messaging are disabled. Credential-aware guards deny demo authority during interrupted passkey promotion. No payment authority is added.

The tradeoff is weaker phone-possession assurance, including number reassignment risk, accepted for consenting demo testers. Disabling the flag removes private demo access. Users with their existing demo session can reverify through ordinary signup and enroll a passkey, preserving identity and clearing the marker. Users who lost that session need a planned transition/support process before the mode is disabled. Existing passkey identities do not inherit phone-only login.

The founder approved and received a one-time reset of the previously diagnosed empty signup, proof/rate-limit history was preserved and database networking restored. The new mode is independently implemented and is not a recovery override for established accounts. **35 identity tests, 27 social tests and the full 314-test suite passed**, plus local synthetic browser flows. Hosted completion remains a separate check.

## Messages channel proof

`POST /api/identity/channel/start {}` requires a recent established session and an idempotency key. The server chooses the account's stored phone; clients cannot replace it. The challenge has purpose `channel` and immutable account/session bindings. The ordinary check endpoint can poll it, but signup/recovery completion rejects its purpose.

`POST /api/identity/channel/complete {challengeId}` requires the same recent account and exact session. It consumes verified evidence once and updates `auth_session.phone_verified_at`. Channel grant creation must check this per-session timestamp, not just the global phone-binding timestamp. A lost channel-completion reply can be retried by the same account/session after the provider window closes; it returns the original verification timestamp and never renews proof freshness. A different session must verify again. A fresh passkey sign-in has no phone-proof timestamp; initial signup and recovery record their fresh proof. Logout/recovery invalidates channel authority when its originating session is deleted.

## Data and operational controls

- Migrations **005_identity.sql** and **009_identity_channel.sql** are independent of demo tables.
- Phone bindings and temporary provider delivery details use AES-256-GCM with authenticated record context. Phone lookup uses a separate HKDF-derived HMAC key. Identity encryption uses `IDENTITY_ENCRYPTION_KEY`, distinct from the earlier demo phone-test key.
- Browser tokens and recovery codes are hashed. Better Auth stores opaque session tokens in its database as its supported library default; this differs from the demo session implementation. Protect the production database and backups accordingly. Session cookie caching is disabled so authorization consults server state.
- Browser account requests can include `X-Tallie-Account`; the server compares it with the canonical signed-in account and rejects stale-account commands. Passkey registration and security reauthentication honor the same binding before changing the cookie.
- `requireAccount` rejects restricted enrollment sessions. `requireRecentAccount` adds a 15-minute assurance requirement. Transactional `lockAccount` holds the established session against concurrent revocation while a command commits.
- Passkey management has a recent user-verified passkey assurance gate. The generic plugin deletion endpoint is disabled. Tallie exposes metadata through `GET /api/identity/passkeys` and removal through `POST /api/identity/passkeys/:id/remove`. Removal locks the user/credentials, refuses to remove the last passkey, and revokes every other session. Recovery-code assurance alone cannot remove credentials: enroll or authenticate with a passkey first.
- Provider dispatch is quota bounded, idempotent and never automatically repeated after an ambiguous result. Check calls are throttled. Mutations check the fixed app Origin, strict JSON schemas and byte limits.
- Better Auth uses database rate limits. With no trusted deployment proxy configured, its supported fallback is a shared per-path bucket; configure trusted infrastructure deliberately before a larger deployment.
- Provider secrets, full phone numbers, codes and raw provider bodies are excluded from application error logs. Temporary proof ciphertext is cleared on expiry checks/new attempts. The exported `cleanupExpiredIdentityProofs` routine clears expired secrets in bounded batches with `SKIP LOCKED`; the runtime worker must schedule it. A documented account-retention policy remains deployment work.

## Local verification

`npx vitest run packages/identity/src/identity.integration.test.ts` passed **23 tests** in an isolated PostgreSQL schema, including:

- Concurrent challenge dispatch and signup completion; stable retry session, lost-reply recovery after the provider window, and logout replay rejection.
- Browser ownership, encrypted PII and rejection of unrelated/demo proof identifiers.
- Expired, wrong-phone, null-phone, wrong-service and wrong-verification evidence.
- Restricted-session denial, phone-only account takeover denial, safe interrupted-enrollment resumption.
- Reload preserves pending/verified proof without redispatch; an expired unconsumed proof permits a fresh attempt. A real Better Auth session with stale enrollment can refresh through fresh same-browser phone proof, preserve account identity and complete synthetic cryptographic passkey enrollment. Private access remains denied until that enrollment succeeds.
- Recovery hashing, one-use redemption, committed attempt counters, old-session revocation and recent-assurance enforcement.
- Actual Better Auth session cookies and actual P-256 WebAuthn registration/authentication verification. Replayed assertions, wrong origins, missing user verification and mismatched expected-account headers are rejected. These are synthetic authenticator tests, not device observations.
- Channel purpose, immutable account/session binding and fresh-assurance checks; proof does not update another session.
- Concurrent credential removals preserve the last passkey and revoke other sessions; recovery-only/stale sessions cannot remove credentials. Expired-secret cleanup leaves current proofs intact.

Strict TypeScript for the identity package and formatting passed. No live Sendblue verification or outgoing message was created by these automated tests.

The interrupted-signup repair additionally passed ten frontend state regressions and the full **291-test / 21-file** aggregate, plus formatting, all-workspace TypeScript and production build. A local production UI with synthetic API responses confirmed automatic name-step restoration, name submission to passkey, Back/Finish setting up without a sign-out call, reload at passkey, stale enrollment to fresh phone entry, reload during renewed verification, and a prefilled name after renewed verification. That fixture made zero provider calls; it validates browser routing independently of the real-PostgreSQL/cryptographic integration tests. The founder's actual device remains the final end-to-end observation.

## Remaining release gates

Observe signup, passkey enrollment, returning sign-in and recovery on actual supported devices, including the final HTTPS domain. Passkeys created for localhost do not migrate to a deployed domain. Confirm Sendblue channel/device coverage before selecting it as the sole phone onboarding path. Verify credential revocation and recovery on devices; finish approved support recovery/phone-change policies, schedule secret cleanup, and validate production database/role isolation, and operational monitoring before treating this as a finished production authentication program.

## Sources checked

- [Better Auth passkey plugin](https://better-auth.com/docs/plugins/passkey)
- [Better Auth database integration](https://better-auth.com/docs/concepts/database)
- Installed package source and declarations for Better Auth/@better-auth/passkey 1.7.6, inspected to verify hooks, session mapping, one-use challenges and user-verification behavior.
