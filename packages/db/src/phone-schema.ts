import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface PhoneChallengeTable {
  id: string;
  ordinal: Generated<string>;
  workspace_id: string;
  session_id: string;
  person_id: string;
  purpose: Generated<'connect_test'>;
  idempotency_key: string;
  phone_hash: string;
  masked_phone: string;
  phone_ciphertext: string | null;
  delivery_ciphertext: string | null;
  service_sid: string;
  verification_sid: string | null;
  status: 'creating' | 'pending' | 'verified' | 'expired' | 'canceled' | 'failed' | 'needs_retry';
  created_at: Timestamp;
  expires_at: Timestamp;
  last_checked_at: NullableTimestamp;
  verified_at: NullableTimestamp;
}

export interface PhoneProofTable {
  challenge_id: string;
  workspace_id: string;
  session_id: string;
  person_id: string;
  purpose: Generated<'connect_test'>;
  created_at: Timestamp;
}
