CREATE TABLE demo_workspaces (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES demo_workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  initials text NOT NULL,
  color text NOT NULL,
  venmo_handle text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES demo_workspaces(id),
  person_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, person_id) REFERENCES people(workspace_id, id),
  UNIQUE (workspace_id, id)
);
CREATE INDEX demo_sessions_expiry_idx ON demo_sessions(expires_at);

CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES demo_workspaces(id),
  paid_by_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  category text NOT NULL CHECK (category IN ('dinner', 'travel', 'coffee', 'groceries', 'tickets', 'other')),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 1 AND 10000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  method text NOT NULL CHECK (method IN ('equal', 'custom', 'items')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  tip_minor bigint NOT NULL DEFAULT 0 CHECK (tip_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  receipt_kind text NOT NULL CHECK (receipt_kind IN ('demo', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, paid_by_id) REFERENCES people(workspace_id, id),
  CHECK (subtotal_minor + tax_minor + tip_minor - discount_minor = total_minor),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, paid_by_id)
);

CREATE TABLE expense_allocations (
  workspace_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  person_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 10000000),
  PRIMARY KEY (expense_id, person_id),
  FOREIGN KEY (workspace_id, expense_id) REFERENCES expenses(workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES people(workspace_id, id),
  UNIQUE (workspace_id, expense_id, person_id, amount_minor)
);

CREATE TABLE payment_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  debtor_id uuid NOT NULL,
  payee_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'paid', 'canceled', 'issue')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  issue_reason text CHECK (length(issue_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (debtor_id <> payee_id),
  FOREIGN KEY (workspace_id, expense_id, payee_id) REFERENCES expenses(workspace_id, id, paid_by_id),
  FOREIGN KEY (workspace_id, expense_id, debtor_id, amount_minor) REFERENCES expense_allocations(workspace_id, expense_id, person_id, amount_minor),
  UNIQUE (expense_id, debtor_id),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, debtor_id, payee_id, amount_minor)
);
CREATE INDEX payment_requests_debtor_idx ON payment_requests(workspace_id, debtor_id, status);
CREATE INDEX payment_requests_payee_idx ON payment_requests(workspace_id, payee_id, status);

CREATE TABLE payment_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  payer_id uuid NOT NULL,
  payee_id uuid NOT NULL,
  request_id uuid,
  request_version integer,
  kind text NOT NULL CHECK (kind IN ('request', 'send')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 10000000),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor = 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source_id text NOT NULL DEFAULT 'demo-balance' CHECK (source_id = 'demo-balance'),
  note text NOT NULL CHECK (length(note) <= 100),
  digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_id <> payee_id),
  CHECK ((kind = 'request' AND request_id IS NOT NULL AND request_version IS NOT NULL) OR (kind = 'send' AND request_id IS NULL AND request_version IS NULL)),
  FOREIGN KEY (workspace_id, session_id) REFERENCES demo_sessions(workspace_id, id),
  FOREIGN KEY (workspace_id, payer_id) REFERENCES people(workspace_id, id),
  FOREIGN KEY (workspace_id, payee_id) REFERENCES people(workspace_id, id),
  FOREIGN KEY (workspace_id, request_id, payer_id, payee_id, amount_minor) REFERENCES payment_requests(workspace_id, id, debtor_id, payee_id, amount_minor),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, payer_id, payee_id, amount_minor)
);

CREATE TABLE payment_consents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  review_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  review_digest text NOT NULL,
  policy_version text NOT NULL DEFAULT 'demo-zero-fee-v1' CHECK (policy_version = 'demo-zero-fee-v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, review_id) REFERENCES payment_reviews(workspace_id, id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES demo_sessions(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES people(workspace_id, id),
  UNIQUE (workspace_id, id, review_id)
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  review_id uuid NOT NULL UNIQUE,
  consent_id uuid NOT NULL UNIQUE,
  payer_id uuid NOT NULL,
  payee_id uuid NOT NULL,
  request_id uuid,
  kind text NOT NULL CHECK (kind IN ('request', 'send')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  provider text NOT NULL DEFAULT 'simulator' CHECK (provider = 'simulator'),
  ready_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, review_id, payer_id, payee_id, amount_minor) REFERENCES payment_reviews(workspace_id, id, payer_id, payee_id, amount_minor),
  FOREIGN KEY (workspace_id, consent_id, review_id) REFERENCES payment_consents(workspace_id, id, review_id),
  FOREIGN KEY (workspace_id, request_id) REFERENCES payment_requests(workspace_id, id),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX operations_one_active_request_idx ON operations(request_id) WHERE request_id IS NOT NULL AND status IN ('queued', 'processing', 'completed');
CREATE INDEX operations_ready_idx ON operations(ready_at) WHERE status IN ('queued', 'processing');

CREATE TABLE settlement_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations(workspace_id, id)
);

CREATE TABLE activity (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  person_id uuid,
  expense_id uuid,
  operation_id uuid,
  type text NOT NULL CHECK (type IN ('split_created', 'payment_sent', 'payment_received', 'request_canceled', 'issue_raised')),
  title text NOT NULL,
  description text NOT NULL,
  emoji text NOT NULL,
  amount_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id) REFERENCES people(workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES people(workspace_id, id),
  FOREIGN KEY (workspace_id, expense_id) REFERENCES expenses(workspace_id, id),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES operations(workspace_id, id)
);
CREATE INDEX activity_feed_idx ON activity(workspace_id, user_id, created_at DESC);

CREATE TABLE api_idempotency (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash text NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, actor_id, scope, key),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES people(workspace_id, id)
);

-- Deferred validation prevents even a direct SQL writer from publishing a
-- partial or unbalanced split. Financial commands still validate before insert.
CREATE FUNCTION verify_expense_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense_key uuid; expected bigint; actual numeric; payer uuid;
BEGIN
  expense_key := CASE WHEN TG_TABLE_NAME = 'expenses' THEN NEW.id ELSE COALESCE(NEW.expense_id, OLD.expense_id) END;
  SELECT total_minor, paid_by_id INTO expected, payer FROM expenses WHERE id = expense_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount_minor), 0) INTO actual FROM expense_allocations WHERE expense_id = expense_key;
  IF expected <> actual OR NOT EXISTS (SELECT 1 FROM expense_allocations WHERE expense_id = expense_key AND person_id = payer) THEN
    RAISE EXCEPTION 'Expense allocations must include its payer and conserve its total' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER expense_conservation AFTER INSERT OR UPDATE ON expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_expense_conservation();
CREATE CONSTRAINT TRIGGER allocation_conservation AFTER INSERT OR UPDATE OR DELETE ON expense_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_expense_conservation();

CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published financial evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER expense_immutable BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON expense_allocations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER review_immutable BEFORE UPDATE OR DELETE ON payment_reviews FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER consent_immutable BEFORE UPDATE OR DELETE ON payment_consents FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON settlement_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER activity_immutable BEFORE UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER idempotency_immutable BEFORE UPDATE OR DELETE ON api_idempotency FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION protect_request_tuple() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id, NEW.expense_id, NEW.debtor_id, NEW.payee_id, NEW.amount_minor) IS DISTINCT FROM ROW(OLD.workspace_id, OLD.expense_id, OLD.debtor_id, OLD.payee_id, OLD.amount_minor) THEN
    RAISE EXCEPTION 'A request financial tuple is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_tuple_immutable BEFORE UPDATE ON payment_requests FOR EACH ROW EXECUTE FUNCTION protect_request_tuple();

CREATE FUNCTION protect_operation_tuple() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id, NEW.review_id, NEW.consent_id, NEW.payer_id, NEW.payee_id, NEW.request_id, NEW.kind, NEW.amount_minor, NEW.note, NEW.provider) IS DISTINCT FROM ROW(OLD.workspace_id, OLD.review_id, OLD.consent_id, OLD.payer_id, OLD.payee_id, OLD.request_id, OLD.kind, OLD.amount_minor, OLD.note, OLD.provider) THEN
    RAISE EXCEPTION 'An approved operation financial tuple is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_tuple_immutable BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION protect_operation_tuple();
