-- Temporary manual-split preview identities are distinct from passkey identities.
-- Disabling the server flag removes their private access without deleting history.
ALTER TABLE auth_user ADD COLUMN phone_demo boolean NOT NULL DEFAULT false;
ALTER TABLE auth_session DROP CONSTRAINT auth_session_assurance_kind_check;
ALTER TABLE auth_session ADD CONSTRAINT auth_session_assurance_kind_check
  CHECK (assurance_kind IN ('onboarding', 'passkey', 'recovery', 'phone_demo'));
