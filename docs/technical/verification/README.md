# Public Natural contract verification

Run from the repository root with standard-library Python:

```sh
python3 docs/technical/verification/check_natural_contract.py
```

This makes one unauthenticated GET of the official public OpenAPI URL and writes `natural-contract-results.json` beside the script. It checks eighteen specific assumptions used in the technical design. It never accesses customer data, creates fixtures, or calls payment/sandbox endpoints.

To reproduce against an archived schema, or require the reviewed snapshot hash:

```sh
python3 docs/technical/verification/check_natural_contract.py --schema /path/to/openapi.json
python3 docs/technical/verification/check_natural_contract.py --expected-sha256 ca3882d75a009fcdcffecd1736237a6ccc9fb29113145df345c539b0fa63c32e
```

Use `--output /path/to/result.json` to preserve an earlier result. Exit code zero means the listed schema assertions passed; one means a check, fetch, parse, or optional hash pin failed. A changed field is a prompt to inspect the contract and update the design, adapter, and relevant tests together. It is not automatically a provider defect.

**Limits:** these are schema checks, not full JSON Schema validation or executable API requests. They establish neither runtime authorization nor SDK serialization, sandbox behavior, funding eligibility, consumer-program access, fee policy, or successful settlement. The conditional `X-Instance-ID` check only describes the schema; the authentication guide establishes its runtime requirement for agent money movement.
