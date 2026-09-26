-- VALIDATION-ONLY schema sketch. This is not an application migration.
-- Run only in the disposable container created by run_postgres_checks.py.

CREATE TABLE share_accounts (
    id text PRIMARY KEY,
    expense_id text NOT NULL,
    participant_id text NOT NULL,
    UNIQUE (expense_id, participant_id)
);

CREATE TABLE execution_guards (
    id text PRIMARY KEY,
    share_account_id text NOT NULL REFERENCES share_accounts(id),
    obligation_revision integer NOT NULL CHECK (obligation_revision > 0),
    direction text NOT NULL CHECK (direction IN ('collect', 'refund')),
    lane text NOT NULL CHECK (lane IN ('natural', 'external')),
    phase text NOT NULL CHECK (phase IN (
        'open', 'reserved', 'submitting', 'unknown', 'held', 'processing',
        'canceling', 'external_open', 'external_reported', 'closed'
    )),
    released_at timestamptz,
    release_evidence text,
    CHECK ((released_at IS NULL AND phase <> 'closed')
        OR (released_at IS NOT NULL AND phase = 'closed' AND release_evidence IS NOT NULL))
);

-- Deliberately excludes revision, direction, lane and phase from the key.
-- The one slot survives transfer-of-control from OPEN request to payment attempt.
CREATE UNIQUE INDEX one_active_guard_per_share_account
    ON execution_guards(share_account_id) WHERE released_at IS NULL;

CREATE TABLE operations (
    id text PRIMARY KEY,
    actor_id text NOT NULL,
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    payload_hash text NOT NULL,
    consent_id text UNIQUE,
    UNIQUE (actor_id, scope, idempotency_key)
);

CREATE FUNCTION reserve_operation(
    p_id text, p_actor text, p_scope text, p_key text, p_hash text,
    p_consent text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    existing operations;
BEGIN
    INSERT INTO operations (id, actor_id, scope, idempotency_key, payload_hash, consent_id)
      VALUES (p_id, p_actor, p_scope, p_key, p_hash, p_consent)
      ON CONFLICT (actor_id, scope, idempotency_key) DO NOTHING;
    SELECT * INTO STRICT existing FROM operations
      WHERE actor_id = p_actor AND scope = p_scope AND idempotency_key = p_key
      FOR UPDATE;
    IF existing.payload_hash <> p_hash OR existing.consent_id IS DISTINCT FROM p_consent THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT' USING ERRCODE = '23514';
    END IF;
    RETURN existing.id;
END;
$$;

CREATE TABLE inbox (
    provider text NOT NULL,
    environment text NOT NULL,
    account_scope text NOT NULL,
    event_id text NOT NULL,
    payload_hash text NOT NULL,
    PRIMARY KEY (provider, environment, account_scope, event_id)
);

CREATE TABLE canonical_movements (
    provider text NOT NULL,
    environment text NOT NULL,
    canonical_payment_id text NOT NULL,
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (provider, environment, canonical_payment_id)
);

CREATE TABLE outbox (
    id text PRIMARY KEY,
    operation_id text NOT NULL REFERENCES operations(id),
    command_type text NOT NULL,
    UNIQUE (operation_id, command_type)
);

INSERT INTO share_accounts VALUES ('share-maya', 'dinner', 'maya');
INSERT INTO share_accounts VALUES ('share-leo', 'dinner', 'leo');
