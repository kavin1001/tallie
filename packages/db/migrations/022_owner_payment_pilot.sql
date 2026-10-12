-- An explicitly enabled local owner-account experiment, separate from customer
-- connections, sandbox money and social obligations. One submitted operation
-- TOTAL per owner account, including failed/unknown/returned operations.
CREATE TABLE natural_owner_pilot_reviews (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES auth_user(id),
  phone_hash text NOT NULL,
  platform_party_id text NOT NULL,
  agent_id text NOT NULL,
  wallet_id text NOT NULL,
  recipient_handle text NOT NULL CHECK(char_length(recipient_handle) BETWEEN 1 AND 100),
  amount_minor integer NOT NULL CHECK(amount_minor BETWEEN 1 AND 100),
  status text NOT NULL CHECK(status IN ('open','expired','confirmed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK(expires_at > created_at),
  CHECK((status='confirmed')=(confirmed_at IS NOT NULL))
);
CREATE INDEX natural_owner_pilot_reviews_account_idx
  ON natural_owner_pilot_reviews(account_id,created_at DESC,id);
CREATE UNIQUE INDEX natural_owner_pilot_one_open_review_idx
  ON natural_owner_pilot_reviews(account_id) WHERE status='open';

CREATE TABLE natural_owner_pilot_sends (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES auth_user(id),
  platform_party_id text NOT NULL UNIQUE,
  review_id uuid NOT NULL UNIQUE REFERENCES natural_owner_pilot_reviews(id),
  operation_id uuid NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  provider_payment_id text UNIQUE,
  recipient_party_id text,
  recipient_agent_id text,
  status text NOT NULL CHECK(status IN (
    'submitting','unknown','CREATED','PROCESSING','PENDING_CLAIM','IN_REVIEW',
    'COMPLETED','FAILED','RETURNED','APPROVAL_DENIED','CANCELED'
  )),
  fee_minor integer CHECK(fee_minor IS NULL OR fee_minor >= 0),
  attention text CHECK(attention IN ('provider_unavailable','binding_mismatch','unresolved_operation')),
  first_submission_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
