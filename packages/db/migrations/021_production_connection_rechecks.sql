-- An authenticated recheck repeats canonical reads of the same saved acceptance.
-- Keep the earlier block/quarantine visible after a successful repair. No bodies,
-- credentials, phone numbers or financial instructions belong in this journal.
CREATE TABLE natural_production_connection_rechecks (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES natural_production_connections(id),
  event_id text NOT NULL,
  previous_status text NOT NULL,
  previous_quarantine_reason text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  result text CHECK(result IN ('processed','retry','quarantined')),
  CHECK((completed_at IS NULL)=(result IS NULL))
);
CREATE INDEX natural_production_connection_rechecks_recent_idx
  ON natural_production_connection_rechecks(connection_id,started_at DESC);
