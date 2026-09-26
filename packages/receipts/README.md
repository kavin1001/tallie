# Tallie receipt capture

This is an owner-private receipt **proposal** pipeline in the local demo. It cannot create a payment or publish an expense. The user reviews and corrects the proposal before returning it to the ordinary split composer, which still asks for the split method.

## API

| Endpoint | Contract |
|---|---|
| `POST /api/receipts` | Active demo session, same origin, `Idempotency-Key`, strict `{contentBase64, contentType}`. Returns `{data: ReceiptDraft}` with 202. |
| `GET /api/receipts/:id` | Only the exact uploading workspace/person/session may read the draft. |
| `GET /api/receipts/:id/image` | Only that uploader session may read the normalized JPEG after extraction. Never serves the original. |

Browser contracts live in `src/contracts.ts`; they contain no server imports. Server helpers do not expose storage paths, source bytes, or provider error bodies in responses. All reads use private, no-store responses. Persona changes revoke access to that session's old drafts; these demo sessions are not production account recovery.

## Pipeline and limits

1. The web process authenticates before reading a bounded JSON body. Only canonical base64 containing JPEG, PNG, or WebP signatures is accepted. A supplied MIME type is not sufficient. No arbitrary URL fetch, SVG, PDF, HEIC, or animation is accepted.
2. A transaction locks the session, reserves upload capacity, records an immutable input hash and retry identity, and queues a receipt. Same-key retries return the same draft; changed bytes conflict. A lost commit reply never causes a committed source file to be deleted.
3. The separate receipt worker claims one row with `FOR UPDATE SKIP LOCKED`. A two-minute lease and token fence prevent old workers from overwriting a replacement result. There are at most two job attempts. Transient provider failures retry once; schema failures and refusals become recoverable user-facing failures.
4. Sharp decodes at most 24 megapixels, applies orientation, strips metadata, flattens onto white, and re-encodes to JPEG within 2400 × 2400. Processing has a ten-second Sharp timeout. It runs outside the web and payment worker.
5. Before every provider attempt, a database reservation enforces the global attempt ceiling. The adapter calls OpenAI Responses with `store: false`, no tools, a strict JSON schema, 6,000 output-token maximum, a 45-second timeout, and a bounded response body. The default pinned model is `gpt-4.1-mini-2025-04-14`.
6. Local validation rejects malformed/oversized money and unrecognized fields, preserves missing versus zero, and reconciles integer cents. Quantities remain separate from extended line totals. Potential private identifiers in labels are replaced with neutral labels and an explicit warning. This conservative text guard is **not a complete redaction system**.
7. Every successful proposal is `review_needed`, including mathematically consistent proposals. No amount is a trusted payment instruction until ordinary user review, split validation, and payer approval happen downstream.

Current limits: 8 MiB source, 100 lines, 10 uploads per workspace per UTC day, 50 uploads globally per UTC day, and 80 provider attempts globally per UTC day. Upload retries do not consume an additional upload slot; extraction retries consume another provider attempt. A provider timeout may have incurred usage even without a usable response. These are bounded request envelopes, not an exact dollar budget.

## Storage and expiry

`RECEIPT_STORAGE_DIR` is an absolute private local directory outside `public`. Root launcher selects the ignored `.tallie/receipts` directory. Generated UUID names prevent caller paths; files use 0600 and the directory uses 0700 on creation. Next's file tracing explicitly excludes dynamic private paths.

Access expires after 24 hours. While the worker is running, a periodic sweep deletes source and normalized files, clears extracted proposals, and cleans matching stale orphan files from interrupted uploads. Minimal job metadata and hashes remain for quota/audit accounting. Unexpected files are never deleted. A stopped worker delays physical deletion, while API access still expires immediately.

No participant, other demo persona, public link, or image CDN receives this photo. Full redacted-image sharing remains unimplemented and must stay gated. Reviewed structured expense details follow the existing participant access rules.

## Environment

- Web: `APP_MODE=demo`, `DATABASE_URL`, `APP_ORIGIN`, `RECEIPTS_ENABLED=true`, `RECEIPT_STORAGE_DIR`.
- Receipt worker: `APP_MODE=demo`, `DATABASE_URL`, `RECEIPTS_ENABLED=true`, `RECEIPT_STORAGE_DIR`, `OPENAI_API_KEY`, optional `RECEIPT_MODEL`.
- Root launcher supplies role-specific environments. The web process does not need the OpenAI secret; the receipt worker does not need payment or messaging secrets.

`store: false` is an API response-storage setting. It is not a claim of zero retention under all provider policies. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

## Verification

Run `npx vitest run packages/receipts/test apps/web/src/server/receipts` with local PostgreSQL available. The current slice has **38 passing tests**: 10 isolated-schema PostgreSQL tests, four HTTP boundary tests, and 24 validation/decoder/provider-fixture tests. The adapter tests use local fake responses and make no external API requests.

Coverage includes concurrent upload retry identity, changed payload, owner/session/workspace ACLs, revocation, private preview, concurrent claims, lease recovery and stale completion fencing, bounded retries, concurrent provider quotas, per-workspace/global upload limits, expiry and orphan cleanup, streamed byte bounds, origin checks, exact cents, missing tip, quantity semantics, PII-like text, malformed media, decoded size, metadata removal, refusal, provider failure, and response limits. A test caught and fixed a claim query that omitted `LIMIT 1` and locked every pending row.

Three annotated synthetic evaluation fixtures are in `fixtures`; see the [evaluation guide](../../docs/technical/receipt-evaluation.md). Real provider evidence is recorded separately by the root integration task. This small set does not establish receipt accuracy for a beta cohort.

## Deployment gates

Before public upload access: deploy private object storage or a persistent private shared volume, enforce operating-system CPU/memory/wall-time limits, give the receipt worker a narrowly scoped database role, add production account assurance and edge abuse controls, complete receipt redaction and participant delivery, and pass the broader consented/synthetic evaluation corpus. The present local database role remains shared; separate processes alone do not establish production isolation. Prompt and schema versions are recorded; normalization is versioned in source and will need per-result provenance before a production decoder upgrade.

Primary API references: [Responses image inputs](https://developers.openai.com/api/docs/guides/images-vision), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
