# Tallie Messages integration

Updated September 26, 2026. This document describes implemented code and local evidence. Ordinary Sendblue delivery, media and callback routing have **not** been exercised on a live device by this implementation task. The founder separately reported that development phone verification worked.

## Implemented boundary

`packages/messaging` contains an ordinary-message transport, authenticated normalization, encrypted PostgreSQL inbox/outbox, revocable account channel grants, durable conversation drafts, exact contact clarification, receipt ingestion hooks, asynchronous receipt hydration and equal-split publication hooks. Next routes accept ordinary inbound messages and status callbacks under `/api/webhooks/sendblue/messages` and `/api/webhooks/sendblue/status`.

The implemented account adapter in `packages/app-services` supplies `validateIdentity`, `resolveContacts`, `ingestReceipt`, `readReceipt`, `publishEqualSplit` and `notificationEligible`. It validates the established account and originating strong session, current verified phone, grant expiry, consent and revocation. A phone-number lookup never creates account authority. A new grant lasts at most seven days and does not survive loss of its originating account session. Identical connect retries reuse the grant and preserve its existing drafts.

The receipt hook shares the account receipt pipeline. Images are downloaded outside the conversation transaction, normalized/extracted by the isolated receipt worker, and later incorporated only when a readable positive USD total, safe title and an explicitly empty extraction-warning list are available. Low-confidence, missing-adjustment and reconciliation warnings require web review even when the total appears plausible. An unreadable total or unsupported currency goes to authenticated web review. Receipt extraction never executes conversation commands.

## Conversation behavior

Examples of supported text:

- `split $117 for dinner with Maya and Leo`
- `with Maya and Leo`
- `equal`, `items`, or `custom`
- `review`
- `CONFIRM <12-character review token>`
- `new split`
- `STOP` / `START`

Names resolve only to exact, unambiguous saved contacts. Each expense requires a new explicit split method. An equal split produces a five-minute summary with exact total, participant amounts and original-payer statement, using the same integer-cent allocation package as the web app. Confirmation binds the draft ID, version, amount, method and immutable participant IDs. Items/custom splits hand off to authenticated web review for assignments and editing.

Publication reserves an immutable draft before calling the social command. The implemented account adapter atomically uses `message_<draftId>` as its permanent social retry identity and revalidates/locks the grant in the publication transaction. STOP/START, revocation, receipt intake and chat publication share a per-phone advisory lock. This avoids both double publication after a lost result and cross-connection grant-lock deadlocks. A reserved draft cannot be edited while its result is unknown. Chat payment words, reactions and delivery statuses have no debit command.

Web completion uses the same permanent social key. Migration011 adds an immutable parsed-input hash reservation so simultaneous chat/web completion cannot publish separate expenses. The complete canonical web review is encrypted before publication, so a lost response or reload can resume the exact approved details through `resumeMessageDraft` without recreating edited custom amounts. A strong established web session can complete its own retained draft after its older chat grant expires; ownership, expected version, exact retry payload and normal social-command authorization still apply. Changed retries fail rather than creating a second request.

## Inbox and consent

- Ordinary callbacks use a constant-time comparison of the configured `sb-signing-secret` header. This is a static secret, **not** a timestamped HMAC. The Verify callback contract is different.
- Request bodies are bounded to 64 KiB; unknown location/account fields are discarded. Group messages are ignored without retaining their content or replying with private financial data.
- Inbound uniqueness is provider account plus message handle; immutable-content conflicts are rejected. Status events retain independent status/time/hash identities so later delivery events are not lost.
- Before processing a conversational command, the worker retrieves the message through Sendblue’s authenticated API and compares handle, sender, receiving line, content, media URL, timestamp, direction and inline parent.
- STOP immediately suppresses queued sends. START must pass the canonical provider check, be newer than the last consent command, and never renews account authority. Old events cannot revive an expired grant or overwrite a newer conversation.
- Intake caps are 2,000 events per provider account per rolling day and 200 per phone hash. STOP remains available after these budgets are reached.

## Outbound behavior and privacy

Sending requires `MESSAGING_SEND_ENABLED=true`, a configured ordinary webhook secret, and a public HTTPS app origin. Each message has a durable semantic key. Before submission, the worker rechecks current identity, consent, expiry and canonical request eligibility. Notifications require separate opt-in. The sending line remains bound to the grant; no line rotation circumvents STOP. Notification seeding excludes already handled recipient/share events across grants and excludes invalid origin sessions, so reconnecting does not resend historical collection messages and a completed first batch cannot starve newer requests. An explicit reminder policy remains future work.

A worker reserves `sending` before calling Sendblue. A timeout, malformed success, 5xx or lost response is `unknown` and is never automatically resubmitted. An expired sending lease likewise becomes `unknown`. Definitive throttling receives a bounded delayed retry. A delivered message never regresses to sent, and a delivery callback cannot change a payment. A raced status callback is requeued after its exact provider handle is bound.

Phone numbers, normalized inbound messages, drafts and outgoing text are encrypted with purpose-bound AES-GCM. Phone lookups use HMAC derived separately for messaging. No provider error body, phone, receipt URL or transcript enters ordinary logs. Originals remain private; this implementation does not claim participant image redaction or provider-side deletion.

Original inbox content and drafts expire after seven days. Outgoing text expires after at most one day. Revoked/expired grant phone ciphertext is purged by maintenance. Minimal deduplication and unknown-delivery metadata remain available for reconciliation; `unknown` is never silently requeued.

## Media egress

Only the documented exact HTTPS host `cdn.sendblue.co` is accepted. URL credentials, alternate ports, fragments and untrusted redirects are rejected. Every hop resolves public IPv4 addresses and pins a validated address to the actual HTTPS socket, retaining TLS hostname verification; the resolver cannot run again after validation. Private, loopback, link-local, metadata, carrier-NAT and special ranges are blocked. The fetch has a 15-second total deadline, two-redirect maximum and streamed 8 MiB cap. Accepted media is JPEG, PNG or WebP; Sharp decoding stays in the receipt worker.

The hostname is verified against public documentation, not an observed live receipt fixture. If Sendblue supplies a different host, the fetch fails closed until that host is independently validated. HEIC remains unsupported.

## Configuration

Server/worker configuration uses:

- `SENDBLUE_API_KEY_ID` and `SENDBLUE_API_SECRET_KEY`
- `SENDBLUE_FROM_NUMBER` — the assigned, stable messaging line
- `SENDBLUE_MESSAGE_WEBHOOK_SECRET` — at least 32 characters; configure the same secret on both ordinary callback endpoints
- `MESSAGING_ENCRYPTION_KEY` — 32 random bytes represented as 64 hexadecimal characters
- `MESSAGING_SEND_ENABLED` — defaults off
- `APP_ORIGIN` and `DATABASE_URL`

The receiver only needs inbox authority; its default hooks cannot process commands or send. The worker must receive the configured account/social hooks. A public HTTPS origin and provider webhook configuration are required for device use. This task did not register a webhook, send a test message or modify provider contacts.

## Evidence and remaining checks

**59 implementation tests pass:** 26 messaging PostgreSQL cases, 12 cross-package account/social/receipt PostgreSQL cases, 16 normalization/grammar/adapter cases and 5 media socket-boundary cases. Provider transports are injected; no real messages are sent. They cover concurrent inbox/outbox deduplication, recipient isolation, canonical mismatch, grant/session invalidation, explicit methods, stale and expired reviews, permanent publication identity after a lost result, queued STOP suppression, out-of-order consent, asynchronous receipt hydration, unknown-delivery recovery and private-content retention. Socket-boundary tests verify public-IP pinning, private DNS rejection, redirect rejection and streamed media bounds. A receipt-poll fairness regression ensures older text drafts and unavailable receipts cannot starve later receipt jobs; migration010 adds the indexed pending-receipt cursor. Cross-package tests run the full chat-to-social-expense path and assert zero financial operations; they also cover fresh enrollment, web publication/retry, link ACLs, grant-lock/STOP ordering, notification fairness and account-owned receipt jobs without AI calls. A public-contract recheck caught and fixed the documented null `sendblue_number` in outbound callbacks.

Before calling Messages verified in a pilot, test actual iPhone receipt media, reply handles, canonical API field shape, account/line routing, SMS fallback disclosure, STOP/START, invite/request links, callback retries and ambiguous sends. Current Sendblue docs say free shared-line plans require provider-verified contacts for inbound routing; completing Verify alone does not establish ordinary inbound routing.

Primary sources checked: [Security and ordinary webhook authentication](https://docs.sendblue.com/security/), [receiving messages and shared-line routing](https://docs.sendblue.com/getting-started/receiving-messages/), [send endpoint](https://docs.sendblue.com/api/resources/messages/methods/send), [canonical message retrieval](https://docs.sendblue.com/api/resources/messages/methods/retrieve).
