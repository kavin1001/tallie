# Security

Tallie is in development. Publishing its source does not authorize a production payment release. General production payments remain gated on provider integration, device testing and founder release approval; see the [implementation tracker](docs/technical/implementation-tracker.md).

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/kavin1001/tallie/security/advisories/new). Include the affected commit, expected behavior, impact and minimal reproduction steps using synthetic data.

Do not include API keys, authentication tokens, customer receipts, phone numbers, identity documents or financial account identifiers in public issues, pull requests or screenshots. For a suspected credential exposure, revoke or rotate the credential with its provider; deleting a file alone does not remove it from Git history.

## Local configuration

- Run `npm run setup` to generate local configuration. `.env.example` contains configuration examples; actual `.env` files, private keys, runtime data and database exports must remain untracked.
- Keep provider credentials on the server. Never put secrets in `NEXT_PUBLIC_` variables, source code, fixtures, browser bundles or Docker build arguments.
- Review the staged diff before publishing. Ignore rules protect untracked files only; they cannot remove a file or secret already committed.
- Automated tests use synthetic identities and mocked providers. Live provider checks and the isolated owner-wallet pilot require separate, explicit configuration and approval.

GitHub secret scanning and push protection are enabled for the public repository. They complement review and dependency checks; they do not detect every possible secret or private artifact.
