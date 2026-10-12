-- Operator controls are independent of provider credentials. Pausing submissions
-- must leave event ingestion, canonical reads and reconciliation available.
CREATE TABLE payment_runtime_controls (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox','production')),
  submissions_paused boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_runtime_controls(environment, submissions_paused)
VALUES ('sandbox', false), ('production', true);

CREATE TABLE payment_runtime_control_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL REFERENCES payment_runtime_controls(environment),
  submissions_paused boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_worker_heartbeats (
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  instance_id uuid NOT NULL,
  seen_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY(environment, instance_id)
);
CREATE INDEX payment_worker_heartbeats_seen_idx ON payment_worker_heartbeats(seen_at);
