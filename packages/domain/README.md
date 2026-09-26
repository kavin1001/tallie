# Financial domain

Pure TypeScript, with no network, database, clocks, random IDs, or provider credentials. Money uses `bigint` cents. Wire representations use canonical decimal strings; never JSON numbers.

## Contracts

- `parseUsd` accepts a dollar decimal with up to two fractional digits. It trims user input, but deliberately rejects currency symbols, grouping separators, scientific notation, and leading zeros. UI normalization must be an explicit separate step.
- `parseMinorUnits` accepts canonical unsigned integer-cent strings within PostgreSQL's signed `bigint` range.
- `formatUsd` provides exact grouped dollar formatting; `formatDecimalUsd` provides a decimal suitable for an amount input or a provider adapter.
- `allocateEqual` and `allocateCustom` return immutable `{ participantId, amountMinor }` arrays sorted by stable participant ID. Zero shares are retained for transparent full-receipt allocations.
- `allocateByItem` requires confirmed line totals, tax, tip, and final total. A line total already accounts for quantity and line discounts. Sharing a line splits that line equally among its assigned participants. Distinct quantity assignments can be represented as separate resolved lines. Receipt discounts follow gross item shares; tax, tip, and service charge follow net item shares. Tax/tip support an explicit equal override. Fully discounted items with a positive proportional adjustment fail with a clarification error instead of inventing a basis.
- `buildObligations` excludes the original payer and zero shares. In each resulting obligation, `payerParticipantId` means the debtor and `payeeParticipantId` means the original payer.
- `getPaymentActions` supplies conservative display guidance from canonical state. It does not authenticate users, authorize a transfer, prove provider cancellation, or reserve a lane. Commands must recheck under the relevant database lock.
- `applyOperationEvent` governs transport outcome only. `accepted` is not payment completion. An uncertain network outcome requires reconciliation; duplicate observations remain idempotent.

## Calculation version

`usd-largest-remainder-v1`: exact integer quotients, largest fractional remainders, then ascending stable participant ID in locale-independent UTF-16 order. Each item and receipt adjustment is rounded independently, so both the line/adjustment columns and final allocations reconcile exactly. Persist the version and returned `tieBreakOrder` with published revisions. Do not recalculate old revisions using future versions.

The storage maximum is not a payment limit. Application/program limits must be checked separately before publication or payment approval. An unset live-payment limit must remain disabled.

## Verification

From the repository root:

```sh
npx vitest run packages/domain/test
npx tsc --noEmit -p packages/domain/tsconfig.json
```

Implementation tests include generated conservation/quota/order properties, maximum-range values, invalid decimal input, exact receipt examples, conflicting states, and external-lane cancellation checks. They establish pure domain behavior; they do not establish database concurrency, provider support, sandbox payment behavior, or live behavior.
