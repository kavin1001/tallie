-- Development phone-possession evidence is deliberately separate from app identities.
ALTER TABLE demo_sessions ADD CONSTRAINT demo_sessions_principal_unique UNIQUE (workspace_id, id, person_id);

CREATE TABLE phone_verification_challenges (
  id uuid PRIMARY KEY,
  ordinal bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  person_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'connect_test' CHECK (purpose = 'connect_test'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[a-f0-9]{64}$'),
  masked_phone text NOT NULL,
  phone_ciphertext text,
  delivery_ciphertext text,
  service_sid text NOT NULL CHECK (service_sid ~ '^SV[A-Za-z0-9]{20,64}$'),
  verification_sid text UNIQUE CHECK (verification_sid ~ '^VR[A-Za-z0-9]{20,64}$'),
  status text NOT NULL CHECK (status IN ('creating', 'pending', 'verified', 'expired', 'canceled', 'failed', 'needs_retry')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  verified_at timestamptz,
  FOREIGN KEY (workspace_id, session_id, person_id) REFERENCES demo_sessions(workspace_id, id, person_id),
  UNIQUE (session_id, idempotency_key),
  UNIQUE (workspace_id, id, session_id, person_id),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK (expires_at > created_at),
  CHECK (status IN ('creating', 'pending') OR (phone_ciphertext IS NULL AND delivery_ciphertext IS NULL))
);
CREATE INDEX phone_challenge_session_recent ON phone_verification_challenges(session_id, created_at DESC);
CREATE INDEX phone_challenge_phone_recent ON phone_verification_challenges(phone_hash, created_at DESC);
CREATE INDEX phone_challenge_recent ON phone_verification_challenges(created_at DESC);

CREATE TABLE phone_proof_claims (
  challenge_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  person_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'connect_test' CHECK (purpose = 'connect_test'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, challenge_id, session_id, person_id)
    REFERENCES phone_verification_challenges(workspace_id, id, session_id, person_id)
);
