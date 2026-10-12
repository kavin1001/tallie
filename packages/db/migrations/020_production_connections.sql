-- Production customer activation is separate from synthetic sandbox customers.
-- Connection readiness never enables a debit or makes a callback financial proof.
CREATE TABLE natural_production_connections (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES auth_user(id),
  environment text NOT NULL DEFAULT 'production' CHECK(environment='production'),
  phone_hash text NOT NULL,
  platform_party_id text NOT NULL,
  agent_id text NOT NULL,
  per_transaction_limit_minor integer NOT NULL CHECK(per_transaction_limit_minor BETWEEN 1 AND 10000),
  effective_per_transaction_limit_minor integer CHECK(
    effective_per_transaction_limit_minor BETWEEN 1 AND per_transaction_limit_minor
  ),
  status text NOT NULL CHECK(status IN ('inviting','pending','verifying','connected','unknown','blocked')),
  invite_operation_id uuid NOT NULL UNIQUE,
  invite_idempotency_key uuid NOT NULL UNIQUE,
  return_state_hash text NOT NULL UNIQUE,
  invitation_id text UNIQUE,
  invitation_url_ciphertext text,
  invitation_expires_at timestamptz,
  accepted_event_id text UNIQUE,
  customer_party_id text UNIQUE,
  delegation_id text,
  wallet_id text UNIQUE,
  lease_token uuid,
  lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK(generation >= 0),
  first_submission_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK(customer_party_id IS DISTINCT FROM platform_party_id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((invitation_id IS NULL)=(invitation_url_ciphertext IS NULL)),
  CHECK((invitation_id IS NULL)=(invitation_expires_at IS NULL)),
  CHECK(status<>'connected' OR (
    invitation_id IS NOT NULL AND accepted_event_id IS NOT NULL AND customer_party_id IS NOT NULL
    AND delegation_id IS NOT NULL AND wallet_id IS NOT NULL AND last_verified_at IS NOT NULL
    AND effective_per_transaction_limit_minor IS NOT NULL
  ))
);
