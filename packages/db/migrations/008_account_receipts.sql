-- Account receipts share the isolated decoder/job engine, never demo identity authority.
ALTER TABLE receipt_captures
  ALTER COLUMN workspace_id DROP NOT NULL,
  ALTER COLUMN person_id DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN account_user_id uuid REFERENCES auth_user(id),
  ADD CONSTRAINT receipt_exactly_one_owner CHECK (
    (account_user_id IS NULL AND workspace_id IS NOT NULL AND person_id IS NOT NULL AND session_id IS NOT NULL)
    OR (account_user_id IS NOT NULL AND workspace_id IS NULL AND person_id IS NULL AND session_id IS NULL)
  );
CREATE UNIQUE INDEX receipt_account_retry_key ON receipt_captures(account_user_id, retry_key)
  WHERE account_user_id IS NOT NULL;
CREATE INDEX receipt_account_quota ON receipt_captures(account_user_id, created_at)
  WHERE account_user_id IS NOT NULL;
