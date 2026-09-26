ALTER TABLE expenses ADD COLUMN published_at timestamptz;
DROP TRIGGER expense_immutable ON expenses;
UPDATE expenses SET published_at = created_at;

CREATE FUNCTION protect_published_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
     AND (to_jsonb(NEW) - 'published_at') = (to_jsonb(OLD) - 'published_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Published financial evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER expense_immutable BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION protect_published_expense();

CREATE FUNCTION reject_published_allocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM expenses WHERE id = NEW.expense_id AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A published expense cannot gain participants' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER published_allocation_immutable BEFORE INSERT ON expense_allocations FOR EACH ROW EXECUTE FUNCTION reject_published_allocation_insert();

CREATE OR REPLACE FUNCTION verify_expense_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense_key uuid; expected bigint; actual numeric; payer uuid; published timestamptz;
BEGIN
  -- A CASE expression resolves fields from both record types before evaluation.
  -- Separate PL/pgSQL branches work for both expense and allocation triggers.
  IF TG_TABLE_NAME = 'expenses' THEN
    expense_key := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    expense_key := OLD.expense_id;
  ELSE
    expense_key := NEW.expense_id;
  END IF;
  SELECT total_minor, paid_by_id, published_at INTO expected, payer, published FROM expenses WHERE id = expense_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount_minor), 0) INTO actual FROM expense_allocations WHERE expense_id = expense_key;
  IF expected <> actual OR published IS NULL OR NOT EXISTS (SELECT 1 FROM expense_allocations WHERE expense_id = expense_key AND person_id = payer) THEN
    RAISE EXCEPTION 'A published expense must include its payer and conserve its total' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE operations ADD CONSTRAINT operation_amount_identity UNIQUE (workspace_id, id, amount_minor);
ALTER TABLE settlement_events ADD CONSTRAINT settlement_matches_operation
  FOREIGN KEY (workspace_id, operation_id, amount_minor) REFERENCES operations(workspace_id, id, amount_minor);
