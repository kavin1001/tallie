import type { ColumnType, Generated } from 'kysely';

type Time = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTime = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface MessageGrantTable {
  id: string;
  provider_account: string;
  account_id: string;
  person_id: string;
  session_id: string;
  binding_epoch: number;
  phone_hash: string;
  phone_ciphertext: string | null;
  sending_line: string;
  notifications: boolean;
  consent_version: string;
  expires_at: Time;
  revoked_at: NullableTime;
  last_message_at: NullableTime;
  created_at: Time;
}

export interface MessagePreferenceTable {
  provider_account: string;
  phone_hash: string;
  stopped_at: NullableTime;
  command_at: Time;
}

export interface MessageInboxTable {
  id: string;
  provider_account: string;
  event_key: string;
  message_handle: string;
  phone_hash: string;
  payload_hash: string;
  payload_ciphertext: string | null;
  kind: 'inbound' | 'status';
  state: Generated<'queued' | 'processing' | 'done' | 'held' | 'ignored'>;
  attempts: Generated<number>;
  lease_token: string | null;
  lease_until: NullableTime;
  available_at: Time;
  error_code: string | null;
  occurred_at: Time;
  created_at: Time;
  expires_at: Time;
}

export interface MessageDraftTable {
  id: string;
  account_id: string;
  grant_id: string;
  version: Generated<number>;
  payload_ciphertext: string;
  closed_at: NullableTime;
  publishing_message_id: string | null;
  web_publication_hash: string | null;
  receipt_pending: Generated<boolean>;
  next_receipt_check_at: Time;
  created_at: Time;
  updated_at: Time;
  expires_at: Time;
}

export interface MessageOutboxTable {
  id: string;
  provider_account: string;
  grant_id: string;
  semantic_key: string;
  kind: 'reply' | 'notification';
  reference: string | null;
  payload_ciphertext: string | null;
  state: Generated<
    'queued' | 'sending' | 'sent' | 'delivered' | 'unknown' | 'failed' | 'suppressed'
  >;
  provider_handle: string | null;
  attempts: Generated<number>;
  lease_token: string | null;
  lease_until: NullableTime;
  available_at: Time;
  provider_updated_at: NullableTime;
  created_at: Time;
  expires_at: Time;
}

export interface MessagingDatabase {
  message_grants: MessageGrantTable;
  message_preferences: MessagePreferenceTable;
  message_inbox: MessageInboxTable;
  message_drafts: MessageDraftTable;
  message_outbox: MessageOutboxTable;
}
