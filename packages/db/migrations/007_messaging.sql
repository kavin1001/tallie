-- No phone possession alone creates account authority. Application identity checks are
-- required when issuing and consuming these short-lived, revocable channel grants.
CREATE TABLE message_grants (
  id uuid PRIMARY KEY,
  provider_account text NOT NULL,
  account_id text NOT NULL,
  person_id uuid NOT NULL,
  session_id text NOT NULL,
  binding_epoch integer NOT NULL CHECK (binding_epoch >= 0),
  phone_hash text NOT NULL,
  phone_ciphertext text,
  sending_line text NOT NULL,
  notifications boolean NOT NULL,
  consent_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '7 days')
);
CREATE UNIQUE INDEX message_grant_active_phone ON message_grants(provider_account, phone_hash) WHERE revoked_at IS NULL;
CREATE INDEX message_grant_account ON message_grants(account_id, created_at DESC);

CREATE TABLE message_preferences (
  provider_account text NOT NULL,
  phone_hash text NOT NULL,
  stopped_at timestamptz,
  command_at timestamptz NOT NULL,
  PRIMARY KEY (provider_account, phone_hash)
);

CREATE TABLE message_inbox (
  id uuid PRIMARY KEY,
  provider_account text NOT NULL,
  event_key text NOT NULL,
  message_handle text NOT NULL,
  phone_hash text NOT NULL,
  payload_hash text NOT NULL,
  payload_ciphertext text,
  kind text NOT NULL CHECK (kind IN ('inbound', 'status')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'done', 'held', 'ignored')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (provider_account, event_key)
);
CREATE INDEX message_inbox_due ON message_inbox(available_at, created_at) WHERE state IN ('queued', 'processing');

CREATE TABLE message_drafts (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  grant_id uuid NOT NULL REFERENCES message_grants(id),
  version integer NOT NULL DEFAULT 1,
  payload_ciphertext text NOT NULL,
  closed_at timestamptz,
  publishing_message_id uuid REFERENCES message_inbox(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX message_draft_active ON message_drafts(grant_id) WHERE closed_at IS NULL;
CREATE INDEX message_draft_account ON message_drafts(account_id, updated_at DESC);

CREATE TABLE message_outbox (
  id uuid PRIMARY KEY,
  provider_account text NOT NULL,
  grant_id uuid NOT NULL REFERENCES message_grants(id),
  semantic_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reply', 'notification')),
  reference text,
  payload_ciphertext text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent', 'delivered', 'unknown', 'failed', 'suppressed')),
  provider_handle text,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (provider_account, semantic_key),
  UNIQUE (provider_account, provider_handle)
);
CREATE INDEX message_outbox_due ON message_outbox(available_at, created_at) WHERE state IN ('queued', 'sending');
