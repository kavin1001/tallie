-- Sandbox-only payment lab. This journal is not a production ledger or social-share settlement.
-- One review authorizes at most one direct wallet payment with immutable source,
-- destination and amount. Provider commands are recorded before network I/O.
CREATE TABLE natural_sandbox_send_reviews (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES auth_user(id),
  client_request_key uuid NOT NULL,
  phone_hash text NOT NULL,
  sender_connection_id uuid NOT NULL REFERENCES natural_sandbox_send_connections(id),
  sender_party_id text NOT NULL,
  sender_wallet_id text NOT NULL,
  recipient_account_id uuid REFERENCES auth_user(id),
  recipient_party_id text NOT NULL,
  recipient_name text NOT NULL,
  recipient_phone_last4 text,
  amount_minor integer NOT NULL CHECK(amount_minor BETWEEN 1 AND 10000),
  note text NOT NULL CHECK(char_length(note) <= 80),
  status text NOT NULL CHECK(status IN ('open','confirmed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  CHECK(sender_party_id <> recipient_party_id),
  CHECK((status='confirmed')=(confirmed_at IS NOT NULL))
);
CREATE INDEX natural_sandbox_send_reviews_account_idx
  ON natural_sandbox_send_reviews(account_id, created_at DESC);
CREATE UNIQUE INDEX natural_sandbox_send_reviews_request_key_idx
  ON natural_sandbox_send_reviews(account_id, client_request_key);

CREATE TABLE natural_sandbox_sends (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES natural_sandbox_send_reviews(id),
  account_id uuid NOT NULL REFERENCES auth_user(id),
  operation_id uuid NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  provider_payment_id text UNIQUE,
  status text NOT NULL CHECK(status IN (
    'prepared','submitting','unknown','CREATED','PROCESSING','PENDING_CLAIM',
    'IN_REVIEW','COMPLETED','FAILED','RETURNED','APPROVAL_DENIED','CANCELED'
  )),
  first_submission_at timestamptz,
  lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK(generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX natural_sandbox_sends_account_idx
  ON natural_sandbox_sends(account_id, created_at DESC);

-- Funding is a separately consented, once-per-sender test deposit. Unknown results
-- retain their key; they cannot be replaced by a fresh deposit to hide uncertainty.
CREATE TABLE natural_sandbox_funding (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES auth_user(id),
  sender_connection_id uuid NOT NULL REFERENCES natural_sandbox_send_connections(id),
  customer_party_id text NOT NULL,
  wallet_id text NOT NULL,
  amount_minor integer NOT NULL CHECK(amount_minor BETWEEN 1 AND 10000),
  operation_id uuid NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  provider_transfer_id text UNIQUE,
  status text NOT NULL CHECK(status IN (
    'prepared','submitting','unknown','CREATED','PROCESSING','IN_REVIEW',
    'COMPLETED','FAILED','RETURNED','APPROVAL_DENIED','CANCELED'
  )),
  first_submission_at timestamptz,
  lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK(generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
