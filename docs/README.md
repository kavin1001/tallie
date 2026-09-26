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
| [Deployment guide](technical/deployment.md)                             | Prepared Docker/Render topology, service configuration, local container evidence, and hosted rollout gates      |
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

Docker/Render deployment artifacts and private S3 storage are prepared; nothing has been hosted or provisioned. Local tests, synthetic live receipt extraction, the founder's earlier phone-proof report, and the container smoke test establish different evidence levels. Natural approval/integration and all real money movement, final-domain device signup/recovery, live messaging callbacks/media/delivery, HEIC, and full redacted receipt sharing remain gates. Demo payments stay confined to the separate simulator.
