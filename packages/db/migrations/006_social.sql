-- Real account collaboration is deliberately separate from synthetic demo money tables.
CREATE TABLE social_contacts (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth_user(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  phone_hash text NOT NULL,
  phone_ciphertext text,
  masked_phone text NOT NULL,
  connected_user_id uuid REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, phone_hash),
  CHECK (owner_user_id IS DISTINCT FROM connected_user_id)
);
CREATE INDEX social_contacts_connected ON social_contacts(connected_user_id);

CREATE TABLE social_expenses (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth_user(id),
  payer_name text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  emoji text NOT NULL,
  category text NOT NULL CHECK(category IN ('dinner','travel','coffee','groceries','tickets','other')),
  total_minor bigint NOT NULL CHECK(total_minor BETWEEN 1 AND 10000000),
  currency text NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
  method text NOT NULL CHECK(method IN ('equal','custom','items')),
  items jsonb NOT NULL,
  subtotal_minor bigint NOT NULL CHECK(subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK(tax_minor >= 0),
  tip_minor bigint NOT NULL CHECK(tip_minor >= 0),
  discount_minor bigint NOT NULL CHECK(discount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_shares (
  id uuid PRIMARY KEY,
  expense_id uuid NOT NULL REFERENCES social_expenses(id),
  participant_id uuid NOT NULL,
  contact_id uuid REFERENCES social_contacts(id),
  user_id uuid REFERENCES auth_user(id),
  phone_hash text NOT NULL,
  private_label text NOT NULL,
  display_name text,
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 10000000),
  is_payer boolean NOT NULL,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(expense_id, participant_id),
  UNIQUE(expense_id, phone_hash),
  CHECK ((is_payer AND contact_id IS NULL AND user_id IS NOT NULL) OR (NOT is_payer AND contact_id IS NOT NULL))
);
CREATE INDEX social_shares_user ON social_shares(user_id, expense_id);
CREATE UNIQUE INDEX social_shares_one_payer ON social_shares(expense_id) WHERE is_payer;

CREATE TABLE social_invitations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth_user(id),
  contact_id uuid NOT NULL REFERENCES social_contacts(id),
  expense_id uuid REFERENCES social_expenses(id),
  phone_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_by_user_id uuid REFERENCES auth_user(id),
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claimed_at IS NULL) = (claimed_by_user_id IS NULL))
);
CREATE INDEX social_invitations_owner ON social_invitations(owner_user_id, created_at);

CREATE TABLE social_idempotency (
  user_id uuid NOT NULL REFERENCES auth_user(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, scope, key)
);

-- Invite acceptance appends identity evidence; it never records money movement.
CREATE TABLE social_invitation_claims (
  invitation_id uuid PRIMARY KEY REFERENCES social_invitations(id),
  user_id uuid NOT NULL REFERENCES auth_user(id),
  session_id uuid NOT NULL,
  phone_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
