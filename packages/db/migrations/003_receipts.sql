-- Private receipt drafts are deliberately independent of published expenses.
-- No receipt image is participant-shareable until the redaction pipeline is implemented.
ALTER TABLE demo_sessions ADD CONSTRAINT demo_sessions_owner_key UNIQUE (workspace_id, id, person_id);
CREATE TABLE receipt_captures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES demo_workspaces(id),
  person_id uuid NOT NULL,
  session_id uuid NOT NULL,
  retry_key text NOT NULL CHECK (length(retry_key) BETWEEN 8 AND 128),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  input_bytes integer NOT NULL CHECK (input_bytes BETWEEN 1 AND 8388608),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'review_needed', 'failed')),
  proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  error_code text,
  normalized_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  model text,
  prompt_version text,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  purged_at timestamptz,
  FOREIGN KEY (workspace_id, person_id) REFERENCES people(workspace_id, id),
  FOREIGN KEY (workspace_id, session_id, person_id) REFERENCES demo_sessions(workspace_id, id, person_id),
  UNIQUE (workspace_id, person_id, session_id, retry_key),
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'review_needed') = (proposal IS NOT NULL)),
  CHECK (status <> 'review_needed' OR normalized_hash IS NOT NULL)
);
CREATE INDEX receipt_capture_pending_idx ON receipt_captures(available_at, created_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX receipt_capture_quota_idx ON receipt_captures(created_at, workspace_id);
CREATE INDEX receipt_capture_expiry_idx ON receipt_captures(expires_at) WHERE purged_at IS NULL;

CREATE TABLE receipt_daily_budget (
  day text PRIMARY KEY CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  provider_attempts integer NOT NULL DEFAULT 0 CHECK (provider_attempts BETWEEN 0 AND 80)
);
