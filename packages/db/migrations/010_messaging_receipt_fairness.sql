ALTER TABLE message_drafts
  ADD COLUMN receipt_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN next_receipt_check_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX message_draft_receipt_due ON message_drafts(next_receipt_check_at)
  WHERE closed_at IS NULL AND receipt_pending;
