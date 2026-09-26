"""Executable design models, not production logic or provider contract tests.

Run: python3 -m unittest discover -s docs/technical/validation -v
Only the Python standard library is required. Amounts are integer USD cents.
"""

from dataclasses import dataclass, replace
from fractions import Fraction
import hashlib
from itertools import permutations
import sqlite3
import unittest


class Blocked(Exception):
    """A requested action cannot safely begin with current knowledge."""


@dataclass(frozen=True)
class Gate:
    """Single obligation, one already-open Natural request, reduced state space.

    Remote transitions here are hypothetical atomic outcomes. Real API semantics
    and cancellation finality must be established by sandbox/partner evidence.
    Reading canonical remote state, not event arrival order, drives local state.
    """

    local: str = "natural_open"
    remote: str = "open"
    revision: int = 1
    approved_revision: int | None = None
    external_exported: bool = False

    def step(self, command):
        if command == "approve":
            if self.local != "natural_open":
                raise Blocked
            return replace(self, local="reserved", approved_revision=self.revision)
        if command == "dispatch":
            if self.local != "reserved" or self.remote != "open":
                raise Blocked
            return replace(self, local="unknown", remote="processing")
        if command == "hosted_pay":
            # A provider-hosted link can race our local cancellation reservation.
            if self.remote != "open":
                raise Blocked
            return replace(self, remote="processing")
        if command == "choose_venmo":
            if self.local != "natural_open":
                raise Blocked
            return replace(self, local="canceling")
        if command == "confirm_cancel":
            if self.local != "canceling":
                raise Blocked
            if self.remote == "open":
                return replace(self, remote="canceled", local="canceled")
            # A payment won the remote race; retain its state, no external link.
            return replace(self, local=self.remote)
        if command == "open_venmo":
            if self.local != "canceled" or self.remote != "canceled":
                raise Blocked
            return replace(self, local="external_open", external_exported=True)
        if command == "report_external":
            if self.local != "external_open":
                raise Blocked
            return replace(self, local="external_reported")
        if command == "confirm_external":
            if self.local != "external_reported":
                raise Blocked
            return replace(self, local="external_settled")
        if command == "provider_hold":
            if self.remote != "processing":
                raise Blocked
            return replace(self, remote="held")
        if command == "provider_complete":
            if self.remote not in {"processing", "held"}:
                raise Blocked
            return replace(self, remote="paid")
        if command == "provider_return":
            if self.remote != "paid":
                raise Blocked
            return replace(self, remote="returned")
        if command == "reconcile":
            if self.local.startswith("external_"):
                return self
            if self.remote in {"processing", "held", "paid", "returned"}:
                return replace(self, local=self.remote)
            return self
        if command == "revise":
            if self.local != "canceled" or self.external_exported:
                raise Blocked
            return replace(self, revision=2, approved_revision=None)
        raise ValueError(command)

    def check(self):
        if self.local.startswith("external_"):
            assert self.remote == "canceled", self
        if self.local in {"reserved", "unknown"}:
            assert self.approved_revision == self.revision, self
        if self.revision == 2:
            assert self.remote == "canceled", self


class MovementJournal:
    """Canonical money evidence keyed by movement, independent of webhooks.

    A movement is signed from participant to original payer. A verified return
    reverses that movement. External evidence is manually confirmed, tagged with
    different provenance; neither route is inferred from a browser return.
    """

    def __init__(self):
        self.movements = {}

    def canonical(self, movement_id, signed_cents, returned=False, external=False):
        previous = self.movements.get(movement_id)
        if previous and previous[0] != signed_cents:
            raise ValueError("Immutable payment amount changed")
        # A stale completion snapshot cannot remove a verified terminal return.
        returned = returned or bool(previous and previous[1])
        self.movements[movement_id] = (signed_cents, returned, external)

    def net_collected(self):
        return sum(amount for amount, returned, _ in self.movements.values() if not returned)

    def residual(self, corrected_target):
        return corrected_target - self.net_collected()


class ReconciliationProjection:
    """Local request-generation fencing plus separate freshness validation.

    This reduced model accepts only processing/completed/fully-returned states.
    Unsupported transitions require a new authoritative read, not enum ranking.
    Provider-version semantics still require actual contract verification.
    """

    def __init__(self):
        self.generation = 0
        self.provider_version = 0
        self.state = "processing"
        self.effects = set()
        self.needs_reconciliation = False

    def start_read(self):
        self.generation += 1
        return self.generation

    def _apply(self, state, provider_version=None):
        allowed = {
            "processing": {"processing", "paid", "returned"},
            "paid": {"paid", "returned"},
            "returned": {"returned"},
        }
        if provider_version is not None and provider_version < self.provider_version:
            return False
        if state not in allowed[self.state]:
            self.needs_reconciliation = True
            return False
        self.state = state
        if provider_version is not None:
            self.provider_version = provider_version
        if state in {"paid", "returned"}:
            self.effects.add("completion")
        if state == "returned":
            self.effects.add("return")
        self.generation += 1
        return True

    def apply_read(self, issued_generation, state, provider_version=None):
        if issued_generation != self.generation:
            return False
        return self._apply(state, provider_version)

    def apply_newer_event(self, state, provider_version):
        if provider_version <= self.provider_version:
            return False
        return self._apply(state, provider_version)


class TrustedInbox:
    """Verified-envelope dedup model; signature verification is out of scope."""

    def __init__(self):
        self.accepted = {}
        self.quarantined = []

    def ingest(self, key, raw_body):
        digest = hashlib.sha256(raw_body).hexdigest()
        original = self.accepted.get(key)
        if original is None:
            self.accepted[key] = digest
            return "process"
        if original == digest:
            return "duplicate"
        self.quarantined.append((key, original, digest))
        return "quarantined"


def allocate_cents(total, weighted_participants):
    """Largest remainder allocation with an explicit stable participant-id tie.

    Exact rational inputs deliberately avoid binary floating point. This model
    specifies a proposed deterministic rounding policy, not a tax engine.
    """
    if total < 0 or not weighted_participants or any(w < 0 for _, w in weighted_participants):
        raise ValueError
    denominator = sum(weight for _, weight in weighted_participants)
    if not denominator:
        if total:
            raise ValueError("Cannot allocate a nonzero amount to zero weights")
        return {participant: 0 for participant, _ in weighted_participants}
    exact = {p: Fraction(total * w, denominator) for p, w in weighted_participants}
    result = {p: value.numerator // value.denominator for p, value in exact.items()}
    ranking = sorted(exact, key=lambda p: (-(exact[p] - result[p]), p))
    for participant in ranking[:total - sum(result.values())]:
        result[participant] += 1
    return result


class DesignTests(unittest.TestCase):
    def test_exhaustive_bounded_gate_sequences(self):
        commands = (
            "approve", "dispatch", "hosted_pay", "choose_venmo", "confirm_cancel",
            "open_venmo", "report_external", "confirm_external", "provider_hold",
            "provider_complete", "provider_return", "reconcile", "revise",
        )
        visited = {Gate()}
        frontier = {Gate()}
        transitions = 0
        for _ in range(9):
            next_frontier = set()
            for state in frontier:
                for command in commands:
                    try:
                        candidate = state.step(command)
                    except Blocked:
                        continue
                    candidate.check()
                    transitions += 1
                    if candidate not in visited:
                        visited.add(candidate)
                        next_frontier.add(candidate)
            frontier = next_frontier
            if not frontier:
                break
        self.assertGreater(len(visited), 25)
        self.assertGreater(transitions, 80)
        print(f"\nBounded gate exploration: {len(visited)} states, {transitions} accepted transitions")

    def test_cancellation_loses_to_hosted_payment(self):
        state = Gate().step("choose_venmo").step("hosted_pay").step("confirm_cancel")
        self.assertEqual(state.local, "processing")
        with self.assertRaises(Blocked):
            state.step("open_venmo")

    def test_cancellation_wins_before_hosted_payment(self):
        state = Gate().step("choose_venmo").step("confirm_cancel").step("open_venmo")
        with self.assertRaises(Blocked):
            state.step("hosted_pay")

    def test_unknown_and_hold_never_unlock_for_another_rail(self):
        state = Gate().step("approve").step("dispatch")
        for command in ("choose_venmo", "revise", "approve"):
            with self.assertRaises(Blocked):
                state.step(command)
        state = state.step("provider_hold").step("reconcile")
        self.assertEqual(state.local, "held")
        with self.assertRaises(Blocked):
            state.step("choose_venmo")

    def test_return_is_not_discarded_as_a_nonmonotonic_webhook(self):
        state = Gate().step("approve").step("dispatch").step("provider_complete").step("reconcile")
        self.assertEqual(state.local, "paid")
        state = state.step("provider_return").step("reconcile")
        self.assertEqual(state.local, "returned")

    def test_cross_revision_active_gate_uniqueness_in_sql(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE execution_guards (
                id TEXT PRIMARY KEY, obligation_id TEXT NOT NULL,
                revision INTEGER NOT NULL, released_at TEXT
            );
            CREATE UNIQUE INDEX one_active_guard_per_obligation
              ON execution_guards(obligation_id) WHERE released_at IS NULL;
        """)
        db.execute("INSERT INTO execution_guards VALUES ('g1','share1',1,NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO execution_guards VALUES ('g2','share1',2,NULL)")
        # Releasing is allowed only after canonical terminal evidence in prod.
        db.execute("UPDATE execution_guards SET released_at='confirmed' WHERE id='g1'")
        db.execute("INSERT INTO execution_guards VALUES ('g2','share1',2,NULL)")
        db.close()

    def test_partial_publish_retry_does_not_duplicate_successful_recipients(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE publication_commands (
                revision TEXT NOT NULL, participant TEXT NOT NULL,
                operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
                PRIMARY KEY(revision, participant)
            );
        """)
        for recipient in ("maya", "leo"):
            db.execute("INSERT INTO publication_commands VALUES (?, ?, ?, 'queued')",
                       ("rev1", recipient, f"rev1:{recipient}"))
        db.execute("UPDATE publication_commands SET state='created' WHERE participant='maya'")
        db.execute("UPDATE publication_commands SET state='unknown' WHERE participant='leo'")
        for recipient in ("maya", "leo"):
            db.execute("INSERT OR IGNORE INTO publication_commands VALUES (?, ?, ?, 'queued')",
                       ("rev1", recipient, f"rev1:{recipient}"))
        states = dict(db.execute("SELECT participant,state FROM publication_commands"))
        self.assertEqual(states, {"maya": "created", "leo": "unknown"})
        self.assertEqual(db.execute("SELECT COUNT(*) FROM publication_commands").fetchone()[0], 2)
        db.close()

    def test_transport_retry_and_expired_provider_dedup_are_separate(self):
        operations = {"op1": {"key": "immutable-key", "state": "unknown", "created": 0}}

        def retry(operation_id, now):
            operation = operations[operation_id]
            if now - operation["created"] >= 48 * 60 * 60:
                raise Blocked("Reconcile/escalate; remote idempotency may have expired")
            return operation["key"]

        self.assertEqual(retry("op1", 10), retry("op1", 60))
        with self.assertRaises(Blocked):
            retry("op1", 49 * 60 * 60)
        self.assertEqual(len(operations), 1)

    def test_duplicate_message_is_distinct_from_duplicate_photo(self):
        seen_envelopes = set()
        drafts = []
        for event_id, image_hash in (("m1", "same-image"), ("m1", "same-image"), ("m2", "same-image")):
            key = ("sendblue", "test-account", event_id)
            if key in seen_envelopes:
                continue
            seen_envelopes.add(key)
            drafts.append((event_id, image_hash))
        self.assertEqual(len(drafts), 2)
        # The second human message is a duplicate candidate, not silently lost.
        self.assertEqual(drafts[0][1], drafts[1][1])

    def test_stale_reconciliation_response_is_fenced_after_completion_and_return(self):
        projection = ReconciliationProjection()
        old_read = projection.start_read()
        newer_read = projection.start_read()
        self.assertTrue(projection.apply_read(newer_read, "paid", provider_version=2))
        self.assertFalse(projection.apply_read(old_read, "processing", provider_version=1))
        self.assertEqual(projection.state, "paid")
        read_before_return = projection.start_read()
        self.assertTrue(projection.apply_newer_event("returned", provider_version=3))
        self.assertFalse(projection.apply_read(read_before_return, "paid", provider_version=2))
        self.assertFalse(projection.apply_newer_event("paid", provider_version=2))
        self.assertEqual(projection.state, "returned")
        self.assertEqual(projection.effects, {"completion", "return"})

    def test_latest_generation_still_needs_provider_freshness_and_transition_validation(self):
        projection = ReconciliationProjection()
        self.assertTrue(projection.apply_newer_event("returned", provider_version=3))
        current_read = projection.start_read()
        # The newest locally issued GET may itself observe stale provider data.
        self.assertFalse(projection.apply_read(current_read, "processing"))
        self.assertTrue(projection.needs_reconciliation)
        self.assertEqual(projection.state, "returned")
        self.assertEqual(projection.effects, {"completion", "return"})

    def test_changed_payload_for_duplicate_webhook_id_is_quarantined(self):
        inbox = TrustedInbox()
        key = ("natural", "sandbox", "payer-account", "event-1")
        first_body = b'{"payment_id":"p1","amount":2600}'
        changed_body = b'{"payment_id":"p1","amount":4600}'
        self.assertEqual(inbox.ingest(key, first_body), "process")
        original_digest = inbox.accepted[key]
        self.assertEqual(inbox.ingest(key, first_body), "duplicate")
        self.assertEqual(inbox.ingest(key, changed_body), "quarantined")
        self.assertEqual(inbox.accepted[key], original_digest)
        self.assertEqual(len(inbox.accepted), 1)
        self.assertEqual(len(inbox.quarantined), 1)

    def test_largest_remainder_preserves_money_and_input_order_does_not_matter(self):
        for cents in range(301):
            for weights in ((("a", 1), ("b", 1), ("c", 1)), (("a", 3), ("b", 1), ("c", 0))):
                expected = allocate_cents(cents, weights)
                self.assertEqual(sum(expected.values()), cents)
                self.assertTrue(all(amount >= 0 for amount in expected.values()))
                for reordered in permutations(weights):
                    self.assertEqual(allocate_cents(cents, reordered), expected)

    def test_hero_receipt_amounts(self):
        food = allocate_cents(6000, (("alex", 1), ("maya", 1), ("leo", 1)))
        wine = allocate_cents(3000, (("alex", 1), ("maya", 0), ("leo", 1)))
        bases = {p: food[p] + wine[p] for p in food}
        tax = allocate_cents(900, tuple(bases.items()))
        tip = allocate_cents(1800, tuple(bases.items()))
        totals = {p: bases[p] + tax[p] + tip[p] for p in bases}
        self.assertEqual(totals, {"alex": 4550, "maya": 2600, "leo": 4550})
        self.assertEqual(sum(v for p, v in totals.items() if p != "alex"), 7150)

    def test_corrections_use_persons_own_target_and_money_evidence(self):
        maya = MovementJournal()
        leo = MovementJournal()
        maya.canonical("pay-maya", 2600)
        self.assertEqual(maya.residual(3000), 400)
        self.assertEqual(leo.residual(4000), 4000)
        # Paid Maya's increase is an explicit adjustment, never added to Leo.
        self.assertEqual(maya.net_collected() + maya.residual(3000), 3000)

    def test_refund_then_bank_return_is_not_hidden_by_paid_state(self):
        journal = MovementJournal()
        journal.canonical("original", 5000)
        self.assertEqual(journal.residual(3000), -2000)
        journal.canonical("refund", -2000)
        self.assertEqual(journal.residual(3000), 0)
        journal.canonical("original", 5000, returned=True)
        self.assertEqual(journal.residual(3000), 5000)
        # This residual creates a reconciliation issue; it never auto-debits.

    def test_duplicate_and_out_of_order_completion_return_evidence(self):
        for ordering in permutations(("complete", "return", "duplicate_complete")):
            journal = MovementJournal()
            for event in ordering:
                journal.canonical("same-provider-payment", 2600, returned=event == "return")
            self.assertEqual(journal.net_collected(), 0)
            self.assertEqual(journal.residual(2600), 2600)
            self.assertEqual(len(journal.movements), 1)

    def test_exported_venmo_link_cannot_be_exactly_once_guaranteed(self):
        journal = MovementJournal()
        # After an explicit 'I did not pay', a user can resume Natural, then use
        # an old exported Venmo link anyway. No app lock can revoke that link.
        journal.canonical("natural", 2600)
        journal.canonical("venmo-report-confirmed", 2600, external=True)
        self.assertEqual(journal.residual(2600), -2600)
        # Detection means preserving both pieces of evidence + manual resolution.
        self.assertEqual(len(journal.movements), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
