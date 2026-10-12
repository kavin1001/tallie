-- Reconciliation reads canonical resources; it never dispatches money movement.
-- Enqueue in the journal transaction so a process crash cannot lose the work.
CREATE TABLE natural_sandbox_reconciliation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid UNIQUE REFERENCES natural_sandbox_sends(id),
  funding_id uuid UNIQUE REFERENCES natural_sandbox_funding(id),
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','paused')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK(generation >= 0),
  wake_version bigint NOT NULL DEFAULT 0 CHECK(wake_version >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  scan_cursor text CHECK(char_length(scan_cursor) <= 1024),
  completed_at timestamptz,
  last_checked_at timestamptz,
  attention_reason text CHECK(attention_reason IN (
    'provider_unavailable','binding_mismatch','unresolved_operation',
    'deposit_identity_unknown','monitor_window_closed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((send_id IS NULL) <> (funding_id IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX natural_sandbox_reconciliation_due_idx
  ON natural_sandbox_reconciliation_jobs(available_at,id) WHERE status='ready';

CREATE FUNCTION enqueue_natural_sandbox_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF TG_TABLE_NAME='natural_sandbox_sends' THEN
      IF NEW.provider_payment_id IS NOT DISTINCT FROM OLD.provider_payment_id THEN RETURN NEW; END IF;
    ELSE
      IF NEW.provider_transfer_id IS NOT DISTINCT FROM OLD.provider_transfer_id THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='natural_sandbox_sends' THEN
    INSERT INTO natural_sandbox_reconciliation_jobs(send_id,available_at,completed_at)
      VALUES(NEW.id,COALESCE(NEW.lease_until,NEW.updated_at),CASE WHEN NEW.status='COMPLETED' THEN NEW.updated_at END)
    ON CONFLICT(send_id) DO UPDATE SET
      status='ready',available_at=LEAST(natural_sandbox_reconciliation_jobs.available_at,EXCLUDED.available_at),
      wake_version=natural_sandbox_reconciliation_jobs.wake_version+1,
      completed_at=COALESCE(natural_sandbox_reconciliation_jobs.completed_at,EXCLUDED.completed_at),updated_at=NEW.updated_at;
  ELSE
    INSERT INTO natural_sandbox_reconciliation_jobs(funding_id,available_at,completed_at)
      VALUES(NEW.id,COALESCE(NEW.lease_until,NEW.updated_at),CASE WHEN NEW.status='COMPLETED' THEN NEW.updated_at END)
    ON CONFLICT(funding_id) DO UPDATE SET
      status='ready',available_at=LEAST(natural_sandbox_reconciliation_jobs.available_at,EXCLUDED.available_at),
      wake_version=natural_sandbox_reconciliation_jobs.wake_version+1,
      completed_at=COALESCE(natural_sandbox_reconciliation_jobs.completed_at,EXCLUDED.completed_at),updated_at=NEW.updated_at;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER natural_sandbox_sends_reconcile
  AFTER INSERT OR UPDATE OF status,provider_payment_id ON natural_sandbox_sends
  FOR EACH ROW EXECUTE FUNCTION enqueue_natural_sandbox_reconciliation();
CREATE TRIGGER natural_sandbox_funding_reconcile
  AFTER INSERT OR UPDATE OF status,provider_transfer_id ON natural_sandbox_funding
  FOR EACH ROW EXECUTE FUNCTION enqueue_natural_sandbox_reconciliation();

INSERT INTO natural_sandbox_reconciliation_jobs(send_id,available_at,completed_at)
SELECT id,COALESCE(lease_until,updated_at),CASE WHEN status='COMPLETED' THEN updated_at END
FROM natural_sandbox_sends;
INSERT INTO natural_sandbox_reconciliation_jobs(funding_id,available_at,completed_at)
SELECT id,COALESCE(lease_until,updated_at),CASE WHEN status='COMPLETED' THEN updated_at END
FROM natural_sandbox_funding;
