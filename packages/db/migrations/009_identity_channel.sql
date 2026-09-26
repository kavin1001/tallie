ALTER TABLE auth_session ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE identity_signup_transactions
  ADD COLUMN purpose text NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup','channel')),
  ADD COLUMN account_id uuid REFERENCES auth_user(id) ON DELETE CASCADE,
  ADD COLUMN session_id uuid REFERENCES auth_session(id) ON DELETE CASCADE,
  ADD CONSTRAINT identity_proof_purpose_binding CHECK (
    (purpose='signup' AND account_id IS NULL AND session_id IS NULL) OR
    (purpose='channel' AND account_id IS NOT NULL AND session_id IS NOT NULL)
  );
