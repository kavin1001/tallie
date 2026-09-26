import type { ColumnType } from 'kysely';
import type { Category, ExpenseItem, SplitMethod } from '@tallie/db/contracts';

type Time = ColumnType<Date, Date | undefined, Date>;
type NullableTime = ColumnType<Date | null, Date | null | undefined, Date | null>;
export interface SocialDatabase {
  social_contacts: {
    id: string;
    owner_user_id: string;
    label: string;
    phone_hash: string;
    phone_ciphertext: string | null;
    masked_phone: string;
    connected_user_id: string | null;
    created_at: Time;
  };
  social_expenses: {
    id: string;
    owner_user_id: string;
    payer_name: string;
    title: string;
    emoji: string;
    category: Category;
    total_minor: string;
    currency: 'USD';
    method: SplitMethod;
    items: ColumnType<ExpenseItem[], string, never>;
    subtotal_minor: string;
    tax_minor: string;
    tip_minor: string;
    discount_minor: string;
    created_at: Time;
  };
  social_shares: {
    id: string;
    expense_id: string;
    participant_id: string;
    contact_id: string | null;
    user_id: string | null;
    phone_hash: string;
    private_label: string;
    display_name: string | null;
    amount_minor: string;
    is_payer: boolean;
    canceled_at: NullableTime;
    created_at: Time;
  };
  social_invitations: {
    id: string;
    owner_user_id: string;
    contact_id: string;
    expense_id: string | null;
    phone_hash: string;
    token_hash: string;
    token_ciphertext: string;
    expires_at: Time;
    claimed_by_user_id: string | null;
    claimed_at: NullableTime;
    revoked_at: NullableTime;
    created_at: Time;
  };
  social_idempotency: {
    user_id: string;
    scope: string;
    key: string;
    request_hash: string;
    resource_id: string;
    created_at: Time;
  };
  social_invitation_claims: {
    invitation_id: string;
    user_id: string;
    session_id: string;
    phone_hash: string;
    created_at: Time;
  };
}
