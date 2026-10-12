# Tallie launch plan

Updated September 26, 2026. **Status: sandbox share payments verified at service level; durable lifecycle and production activation foundation implemented locally**, following the founder's instruction to build P2P. The founder approved a $100/month recurring ceiling, superseding the earlier $0 budget. Treat it as an all-in cap until existing provider subscriptions are clarified. The Natural local-test/release gate remains in force; no infrastructure has been upgraded or production funds enabled.

## Starting point

The hosted preview supports accounts, friends and manual splits. The separate local Natural lab completed a $25 synthetic deposit and a $1 direct transfer between one user's two test customers; sender $24, receiver $1 and the completed record survived reload. That milestone passed 458 tests; the later share-linked P2P implementation passed 497 tests, formatting, TypeScript and build. This is a narrow sandbox observation. The separate direct-send lab remains independent of expenses. The later share-linked slice now settles only explicitly opted-in sandbox splits; manual expenses are unchanged.

The share-linked follow-up used two synthetic fixture identities, actual Natural sandbox setup, a $5 deposit and one $1 repayment. Both paid projections, zero outstanding dashboard totals, exact wallet deltas and one send under repeated confirmation were verified, including a safe resume. Two real people on devices still need to exercise the experience.

Receipt capture and Messages workflows have implementation evidence but remain disabled on the hosted preview. Ordinary iMessage delivery/media has not been verified end to end; receipt sharing still needs a redacted image derivative and participant access checks. See the [tracker](implementation-tracker.md) and [verification register](verification-register.md).

## First product loop

A user adds a receipt, confirms its total, names friends and chooses a split method. Each friend opens a private request, completes any necessary signup/payment activation, reviews the exact amount and funding source, and explicitly approves. Both sides see the same durable payment status and updated share balance.

Keep agreed P2P scope: several individual requests from one receipt, no persistent groups. Keep signup primary and Venmo secondary; external payments must remain explicitly reported/confirmed rather than provider-verified. Delay Natural activation until the user needs it, preserving the request through onboarding and review. This timing is a UX proposal; required financial identity checks cannot be skipped.

## Delivery sequence and exit criteria

| Milestone | Work | Exit evidence |
| --- | --- | --- |
| 1. Two-person repayment in sandbox | Connect a real Tallie share to immutable financial review, explicit payer consent, one active collection operation and settlement effects. Preserve the separate direct-send lab. | Two distinct consenting Tallie accounts create, claim, approve and settle one request. Both dashboards agree. Duplicate confirmations, wrong recipients, cancellation races, unknown results and returns have tests; record actual provider behavior separately. |
| 2. Production activation contract | P2P approved per founder; implement and verify supported invitation/KYC/permission binding, interrupted onboarding, bank funding and withdrawal. Confirm fees, availability timing, limits and responsibilities. | Approved program and observed supported onboarding path. Server verifies the intended customer and grant; redirect alone is insufficient. A known supported path gets money into and out of the wallet. |
| 3. Payment lifecycle and account protection | Strong recent authentication for real debits, safe migration of phone-demo accounts, durable dispatch, signed webhook inbox, deduplication, canonical reconciliation and delayed-return effects. | State converges without an open browser. Worker restart, lost replies, repeated/out-of-order hooks and late returns cannot duplicate payments or leave incorrect paid balances. Approved recovery works on real devices. |
| 4. Complete mobile web experience | Resume requests after signup/KYC; receipt corrections and recoverable drafts; full redacted receipt and share transparency; clear pending/failed/returned states; private invitations. | End-to-end journeys on actual iPhones and supported browsers, including app switching, interrupted signup, expired links, slow network and receipt failures. Evaluate diverse receipts rather than claiming accuracy from the existing three-image smoke. |
| 5. Hosted private beta | Separate environments/credentials, durable database with backups, restore test, running workers, private receipt storage, monitoring, payment limits, pause controls, support and reviewed user disclosures. | Deploy/rollback and restore exercised; alerts identify unresolved payments; support can inspect safe operation history. Founder approves the concrete release after local testing. |
| 6. iMessage pilot | Enable consented channel connection, public callbacks and receipt media; use the same expense/payment services. Initially hand off payment approval to authenticated web review. | Two consenting iPhone users exercise receipt intake, contact ambiguity, every-time split selection, request delivery, duplicate callbacks and STOP/START. Native chat approval is a later separately reviewed authority design. |

Milestones overlap: production setup and infrastructure planning can proceed alongside sandbox repayment work. The web-first sequence is a recommendation to reduce launch dependencies; it does not remove iMessage from the product vision.

## External decisions needed

- **Natural:** P2P approval is founder-confirmed. The founder reports production setup is still needed. Verify production credential/agent binding and production terms. Clarify whether the approved path can fund a payment from a linked bank at approval or requires prefunding, plus cash-out, fees, holds and returns. This materially affects the experience.
- **Infrastructure:** select and verify a resource plan within the approved $100/month ceiling before provisioning paid resources. Retain Render to avoid a hosting migration unless a measured constraint requires one. The current free configuration cannot supply the proposed durable payment runtime; its recorded database expiry is October 26, 2026.
- **Domain:** choose the permanent HTTPS domain before final passkey/device enrollment tests. Localhost credentials do not establish production-domain behavior.
- **Release:** founder completes the local test and approves a specific release. Natural code stays local until that approval; the budget increase does not override the release gate.

## Budget plan — approved ceiling $100/month

A lean paid Render topology can preserve all four runtime roles for **$66.50/month fixed** at the public list prices checked September 26: web 512 MB $7, maintenance 512 MB $7, receipts 2 GB $25, Messages 512 MB $7, PostgreSQL 1 GB $19, and 5 GB database storage $1.50; Hobby workspace $0. This is a proposal, not provisioned infrastructure. The existing paid Blueprint still uses a 2 GB web service and would total $84.50 on the same pricing. Start the web role smaller only after measuring the enabled workload. [Render pricing](https://render.com/pricing), [compute plans](https://render.com/docs/compute-plans).

Allow roughly $2–3 for private S3 as an initial planning allowance, with the remainder for provider usage, bandwidth, builds, taxes and contingency. Usage can exceed an allowance; alerts and application quotas are needed before enabling a public beta. S3 charges separately for storage, requests and transfer. [AWS S3 pricing](https://aws.amazon.com/s3/pricing/).

Sendblue's public dedicated AI Agent line is **$100/month alone**; its free sandbox is limited to ten verified contacts and inbound-first interactions. Keep messaging within available sandbox access while the $100 ceiling is treated as all-in. Check the founder's actual plan before upgrading or promising public messaging under this budget. [Sendblue plans](https://www.sendblue.com/).

Upgrade the existing database before its recorded **October 26, 2026** expiry. Paid PostgreSQL on Hobby supplies three-day point-in-time recovery; exercise a restore before live funds. Preserve the separate local Natural release gate. [Render free limits](https://render.com/docs/free), [database backups](https://render.com/docs/postgresql-backups).

## Initial rollout proposal

Start with 10–20 invited users and small, provider-approved payment limits. Require two-person device proof and operational readiness before live funds. Measure request-to-approval completion, onboarding abandonment, repeated splitting, unresolved payments, time to recover failures and cost per completed split. Increase access after repeated successful journeys and resolved failures, rather than using a test-count target alone.

## Current primary sources

- [Natural Connect](https://docs.natural.com/guides/connect/invite-customer): production acceptance includes account verification and wallet authorization; sandbox simulation differs, and redirects are not authoritative acceptance evidence.
- [Natural compliance](https://docs.natural.com/guides/overview/compliance): individual verification requires more than phone proof; verification can require review. Actual Tallie onboarding remains to be observed.
- [Render free service limits](https://render.com/docs/free): free web services sleep after inactivity; free PostgreSQL expires after 30 days and has no backups. These public limits corroborate the current topology constraint, not a fresh inspection of the deployed account.

## Current operational milestone

Durable sandbox reconciliation, signed-event inboxes, encrypted retention, pause/health tools, offline readiness checks and a production hosted-invitation foundation are implemented locally. The connection UI/API preserve setup across interruptions and do not treat redirects as acceptance. Only accepted-invitation events are processed in production; live financial events remain quarantined. This advances milestones 2–3 but does not complete bank funding/cash-out, production share debits, alerts/restores or real-device rollout. [Runbook and exact remaining work](payment-operations.md).
