-- Opt-in sandbox obligations remain separate from earlier manual expenses.
ALTER TABLE social_expenses
  ADD COLUMN payment_environment text NOT NULL DEFAULT 'manual'
  CHECK (payment_environment IN ('manual', 'sandbox'));

-- A share review freezes the exact debtor, creditor, amount and source at consent.
-- The attempt snapshot forces a fresh review after any earlier terminal send.
ALTER TABLE natural_sandbox_send_reviews
  ADD COLUMN share_id uuid REFERENCES social_shares(id),
  ADD COLUMN share_attempt_snapshot bigint NOT NULL DEFAULT 0 CHECK (share_attempt_snapshot >= 0),
  ADD CONSTRAINT natural_sandbox_share_review_recipient
    CHECK (share_id IS NULL OR recipient_account_id IS NOT NULL);
CREATE INDEX natural_sandbox_send_reviews_share_idx
  ON natural_sandbox_send_reviews(share_id, created_at DESC) WHERE share_id IS NOT NULL;
CREATE UNIQUE INDEX natural_sandbox_send_reviews_identity_share_idx
  ON natural_sandbox_send_reviews(id, share_id);

-- DB uniqueness protects against two distinct reviews being confirmed for one
-- active or successful share payment, even if application locking regresses.
ALTER TABLE natural_sandbox_sends
  ADD COLUMN share_id uuid REFERENCES social_shares(id),
  ADD COLUMN attempt_sequence bigint GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT natural_sandbox_send_review_share_fk
    FOREIGN KEY (review_id, share_id)
    REFERENCES natural_sandbox_send_reviews(id, share_id);
CREATE UNIQUE INDEX natural_sandbox_one_open_share_send_idx
  ON natural_sandbox_sends(share_id)
  WHERE share_id IS NOT NULL
    AND NOT (status IN ('FAILED', 'RETURNED') AND provider_payment_id IS NOT NULL);
CREATE INDEX natural_sandbox_sends_share_attempt_idx
  ON natural_sandbox_sends(share_id, attempt_sequence DESC)
  WHERE share_id IS NOT NULL;
