-- Verified Natural deliveries are durable hints. They cannot settle a share or
-- authorize a provider mutation. Retain identity/hash after encrypted body expiry.
CREATE TABLE natural_webhook_inbox (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK(environment IN ('sandbox','production')),
  platform_party_id text NOT NULL,
  agent_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  source_party_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  operation_id uuid,
  payload_hash text NOT NULL CHECK(char_length(payload_hash)=64),
  payload_ciphertext text,
  event_created_at timestamptz NOT NULL,
  signed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','processing','processed','quarantined')),
  quarantine_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  conflict_count integer NOT NULL DEFAULT 0 CHECK(conflict_count>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  processed_at timestamptz,
  UNIQUE(environment, platform_party_id, event_id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((status='processing')=(lease_token IS NOT NULL)),
  CHECK((status='quarantined')=(quarantine_reason IS NOT NULL))
);
CREATE INDEX natural_webhook_inbox_work_idx
  ON natural_webhook_inbox(environment,platform_party_id,agent_id,available_at)
  WHERE status IN ('pending','processing');
CREATE INDEX natural_webhook_inbox_retention_idx
  ON natural_webhook_inbox(payload_expires_at) WHERE payload_ciphertext IS NOT NULL;
