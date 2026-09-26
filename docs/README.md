# Tallie project docs

Start with the [product requirements](payments-prd.md), then the [living technical design](payments-technical-design.md).

| Document                                                                | Purpose                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Product requirements](payments-prd.md)                                 | Agreed experience, scope, visual direction, acceptance criteria                                                 |
| [Technical design](payments-technical-design.md)                        | Architecture, data, payment state/concurrency, APIs, identity, channels, operations and implementation sequence |
| [Decision log](technical/decision-log.md)                               | Selected tradeoffs, costs and revisit conditions                                                                |
| [Verification register](technical/verification-register.md)             | Tested/documented assumptions and remaining partner, sandbox and device gates                                   |
| [Receipt evaluation](technical/receipt-evaluation.md)                   | Synthetic fixtures, live extraction evidence, and wider accuracy gates                                          |
| [Identity integration](technical/identity-integration.md)               | Persistent accounts, required passkeys, recovery, session assurance, and remaining device checks                |
| [Social integration](technical/social-integration.md)                   | Private contacts, intended-recipient invitations, shared expenses, cancellation, and authorization              |
| [Messages integration](technical/messaging-integration.md)              | Durable iMessage/SMS drafts, consent, receipt intake, publication, and delivery uncertainty                     |
| [Sendblue development integration](technical/sendblue-integration.md)   | Earlier isolated phone-proof test; no account or payment authority                                              |
| [Deployment guide](technical/deployment.md)                             | Live free preview, release evidence, resource limits, retained paid topology and remaining device checks       |
| [Private receipt storage](technical/deployment-storage.md)              | S3 object layout, per-service permissions, retention, and live storage checks                                   |
| [Provider setup](technical/provider-setup.md)                           | Exact accounts, credentials and integration gates for the founder                                               |
| [Implementation tracker](technical/implementation-tracker.md)           | Actual build progress and next vertical slice                                                                   |
| [Implementation verification](technical/implementation-verification.md) | Reproducible test results, observed browser flows, and local limitations                                        |
| [Design validation](technical/validation/README.md)                     | Reproducible state/money models and isolated PostgreSQL experiments                                             |
| [Public contract checks](technical/verification/README.md)              | Reproducible Natural OpenAPI assertions and source hash                                                         |
| [Natural audit](research/natural-technical-audit.md)                    | Detailed primary-source integration findings                                                                    |
| [Channel and identity audit](research/channel-identity-audit.md)        | iMessage, guest, receipt and Venmo integration findings                                                         |

## Keeping this live

Update the affected design section and tracker with each material build change. Preserve old decisions when superseding them. Record verification at the level actually demonstrated: docs, local model/database, sandbox, or live pilot. Link implementation/tests when marking work implemented. Keep secrets and real customer information out of the repository.

The repository contains a local Tallie account app with persistent phone-bound identities, required passkeys, recovery, contacts, private invitations, real shared-expense records, receipt capture, and durable Messages workflows. Four runnable roles share PostgreSQL and application services: web, maintenance, receipt processing, and messaging. See the root [run guide](../README.md) and [implementation tracker](technical/implementation-tracker.md) for the current integration state.

The free account/manual-split preview is live at [tallie-web.onrender.com](https://tallie-web.onrender.com), backed by private Render PostgreSQL and the private [kavin1001/tallie repository](https://github.com/kavin1001/tallie). Local checks, 278 tests, Linux CI, a constrained container smoke and live HTTPS/session/access checks passed. Native hosted signup/passkeys and two-person invitations are the next checks. The web service sleeps when idle; this database expires October 26, 2026.

AWS storage remains deferred because account-specific free-plan coverage was not confirmed. Receipts, the Messages agent and payments are disabled in this deployment. Natural approval/integration, final-domain device signup/recovery, live messaging callbacks/media/delivery, HEIC and full redacted receipt sharing remain gates. Demo payments stay confined to the separate local simulator and are unavailable on the hosted preview.
