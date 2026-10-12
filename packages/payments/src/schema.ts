import type { ColumnType } from 'kysely';
import type { SandboxConnectionStatus } from './contracts';

export type SandboxPhase = 'invite' | 'accept' | 'verify' | 'balances';
export interface StoredSandboxBalance {
  id: string;
  providerWalletId: string;
  currency: 'USD';
  availableMinor: string | null;
  totalMinor: string | null;
}
export interface SandboxConnectionTable {
  id: string;
  account_id: string;
  environment: 'sandbox';
  phone_hash: string;
  platform_party_id: string;
  agent_id: string;
  permissions: ColumnType<string[], string, never>;
  status: SandboxConnectionStatus;
  phase: SandboxPhase;
  invite_operation_id: string;
  invite_idempotency_key: string;
  accept_operation_id: string;
  accept_idempotency_key: string;
  invitation_id: string | null;
  customer_party_id: string | null;
  delegation_id: string | null;
  balances: ColumnType<StoredSandboxBalance[], string, string>;
  first_submission_at: Date | null;
  lease_until: Date | null;
  generation: number;
  created_at: Date;
  updated_at: Date;
}
export interface PaymentDatabase {
  natural_sandbox_connections: SandboxConnectionTable;
  natural_sandbox_send_connections: SandboxConnectionTable;
}
