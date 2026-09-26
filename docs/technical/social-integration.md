# Real accounts, friends, and invitations

Updated September 26, 2026. **Implemented and tested against local PostgreSQL.** Hosted and two-device evidence is still pending.

## Boundaries

`@tallie/social` and migration006 keep real contacts, expense allocations, invitations, and claim evidence separate from every synthetic demo/payment table. A saved share is an app obligation awaiting payment setup. No social command creates a Natural request, financial consent, simulator operation, or money movement.

Mutations require a live passkey/recovery account session, rechecked and share-locked inside the database transaction. A phone-only enrollment session cannot create or claim collaboration records. The message worker has a separate trusted publication entrypoint: its callback must lock and validate the current channel grant inside that same transaction. No HTTP input can override authorization.

## Contact identity and privacy

- Contacts use explicitly entered US numbers, an HMAC under the identity key, encrypted phone storage, and a private label. Adding a number never reveals whether it has a Tallie account.
- An account can have 200 contacts. Aliases resolve only on an exact, uniquely matching normalized label. Duplicate names need clarification; partial or fuzzy matches are not guessed.
- Contact UUID, verified phone fingerprint, and published participant snapshot remain stable. There is no phone-rebinding API in this slice.
- Accepting an invitation creates a mutual connection. The reverse contact stores the sender's verified phone fingerprint and masked number without copying their raw phone.
- The expense owner sees their private nicknames. Other participants see verified names, or “Invited friend” until that participant joins. Phone numbers and private aliases never appear in participant expense responses.

## Invitation lifecycle

The owner deliberately creates a personal share link. It uses 32 random bytes in `/invite#token=…`; HTTP paths, link previews, and referrers need not carry the secret. The database stores its SHA-256 hash for lookup and authenticated ciphertext for exact retry responses. Default expiry is seven days; limit is 100 invitations per owner per day.

Anonymous inspection returns only availability and the generic purpose `join_tallie`. Claiming requires the exact intended verified phone fingerprint and a strong account session. The token alone grants no access. An expense invitation claims only its matching share; a friendship-only invitation leaves earlier unclaimed expenses private. Connected friends can see future shared expenses.

Claims acquire account locks, a stable account-pair advisory lock, invitation lock, then contact/share locks. Claim evidence is unique per invitation. Concurrent same-account retries return the same result. Wrong-account, forwarded, expired, revoked, and canceled-share cases fail without granting access. Revocation preserves the underlying expense; it cannot remove access already granted by acceptance.

The browser preserves pending invitation context through signup. It copies/shares only on a user action. No route automatically texts a new contact. A localhost invitation requires the same local computer; cross-device acceptance needs the hosted app.

## Splits and history

Equal, custom, and item methods use the existing integer-cent allocation domain. Every publication includes the original payer; missing tax/tip, unknown contacts, mismatched totals, duplicate participants, and malformed amounts are rejected. The method is selected for every new expense. Limit is 50 expenses per owner per rolling day.

An expense publishes once per stable idempotency key and payload. Dashboard balances aggregate all outstanding shares independently of the 100-expense display limit. Full detail is fetched by expense ID under participant authorization. Owner cancellation preserves the original allocation and first cancellation timestamp; canceled shares leave outstanding totals and cannot be newly claimed.

Receipt images stay private. Item descriptions, confirmed components, and participant allocations are visible to authorized participants. Redacted photo sharing, corrections, disputes, recipient blocking, pagination beyond the current history window, and live payment activation remain separate work.

## HTTP surface

Every route uses `/api/social`, no-store responses, and bounded JSON. Mutations enforce the configured origin.

| Route                                       | Behavior                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /dashboard`                            | Current user's contacts, participant expenses, complete totals, receipt capability |
| `POST /contacts`                            | Explicit phone and private label; stable retry key                                 |
| `POST /expenses`                            | Confirmed allocation input; stable retry key                                       |
| `GET /expenses/:id`                         | Participant-scoped detail and all shares                                           |
| `POST /expenses/:id/shares/:shareId/cancel` | Owner cancels an unpaid app obligation                                             |
| `POST /invitations`                         | Owner creates a scoped private link; stable retry key                              |
| `POST /invitations/inspect`                 | Anonymous, generic availability only                                               |
| `POST /invitations/claim`                   | Intended verified account claims once                                              |
| `POST /invitations/:id/revoke`              | Owner disables an unaccepted link                                                  |

## Verification

`npx vitest run packages/social/src/social.integration.test.ts` passes **19 real PostgreSQL implementation tests**. Coverage includes contact encryption and non-enumeration; duplicate commands; enrollment/revoked sessions; ambiguous labels; exact allocations; foreign contact/expense privacy; concurrent publication; hashed/encrypted fragment invitations; wrong-phone and forwarded links; scoped claims; private aliases; concurrent one-time claims; prior/future expense visibility; expiry/revocation; cancellation; worker authorization in the publication transaction; simultaneous opposite-direction invitations; revocation/acceptance races; and complete totals beyond the 100-expense display window. No external message or payment is sent by these tests.

`npx tsc -p packages/social/tsconfig.json` passes. UI is implemented in `account-home.tsx` and `account/`; browser and hosted results belong in the main verification report after observation.
