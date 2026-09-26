-- Persistent app identities are separate from every demo workspace/person/session.
CREATE TABLE auth_user (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  assurance_kind text NOT NULL DEFAULT 'onboarding' CHECK (assurance_kind IN ('onboarding','passkey','recovery')),
  assurance_at timestamptz
);
CREATE INDEX auth_session_user ON auth_session(user_id);
CREATE TABLE auth_account (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id,account_id)
);
CREATE TABLE auth_verification (
  id uuid PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verification_identifier ON auth_verification(identifier);
CREATE TABLE auth_passkey (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  name text,
  public_key text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  counter bigint NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text,
  created_at timestamptz,
  aaguid text
);
CREATE INDEX auth_passkey_user ON auth_passkey(user_id);
CREATE TABLE identity_phone_bindings (
  user_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  phone_hash text NOT NULL UNIQUE,
  phone_ciphertext text NOT NULL,
  masked_phone text NOT NULL,
  verified_at timestamptz NOT NULL
);
CREATE TABLE identity_signup_transactions (
  id uuid PRIMARY KEY,
  browser_hash text NOT NULL,
  idempotency_key text NOT NULL,
  phone_hash text NOT NULL,
  phone_ciphertext text,
  masked_phone text NOT NULL,
  service_sid text NOT NULL,
  verification_sid text UNIQUE,
  delivery_ciphertext text,
  status text NOT NULL CHECK(status IN ('creating','pending','verified','expired','failed','needs_retry','complete')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  completed_user_id uuid REFERENCES auth_user(id) ON DELETE CASCADE,
  result_ciphertext text,
  recovery_attempts integer NOT NULL DEFAULT 0,
  UNIQUE(browser_hash,idempotency_key)
);
CREATE INDEX identity_signup_browser ON identity_signup_transactions(browser_hash,created_at DESC);
CREATE INDEX identity_signup_phone ON identity_signup_transactions(phone_hash,created_at DESC);
CREATE TABLE identity_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX identity_recovery_user ON identity_recovery_codes(user_id);
CREATE TABLE identity_rate_limits (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
