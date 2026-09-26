import type { ColumnType, Generated } from 'kysely';

type Time = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTime = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface ReceiptCaptureTable {
  id: string;
  workspace_id: string | null;
  person_id: string | null;
  session_id: string | null;
  account_user_id: Generated<string | null>;
  retry_key: string;
  input_hash: string;
  content_type: 'image/jpeg' | 'image/png' | 'image/webp';
  input_bytes: number;
  status: Generated<'queued' | 'processing' | 'review_needed' | 'failed'>;
  proposal: ColumnType<unknown | null, string | null | undefined, string | null>;
  error_code: string | null;
  normalized_hash: string | null;
  attempts: Generated<number>;
  lease_token: string | null;
  lease_until: NullableTime;
  available_at: Time;
  model: string | null;
  prompt_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Time;
  updated_at: Time;
  expires_at: Time;
  purged_at: NullableTime;
}

export interface ReceiptBudgetTable {
  day: string;
  provider_attempts: Generated<number>;
}
