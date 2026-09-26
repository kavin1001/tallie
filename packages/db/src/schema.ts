import type { ColumnType, Generated } from 'kysely';
import type { ReceiptCaptureTable, ReceiptBudgetTable } from './receipt-schema';
import type { PhoneChallengeTable, PhoneProofTable } from './phone-schema';
import type {
  Category,
  ExpenseItem,
  OperationStatus,
  RequestStatus,
  SplitMethod,
} from './contracts';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Money = ColumnType<string, string, string>;

interface WorkspaceTable {
  id: string;
  created_at: Timestamp;
}
interface PeopleTable {
  id: string;
  workspace_id: string;
  name: string;
  initials: string;
  color: string;
  venmo_handle: string | null;
  created_at: Timestamp;
}
interface SessionTable {
  id: string;
  token_hash: string;
  workspace_id: string;
  person_id: string;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}
interface ExpenseTable {
  id: string;
  workspace_id: string;
  paid_by_id: string;
  title: string;
  emoji: string;
  category: Category;
  total_minor: Money;
  currency: Generated<'USD'>;
  method: SplitMethod;
  version: Generated<number>;
  items: ColumnType<ExpenseItem[], string, never>;
  subtotal_minor: Money;
  tax_minor: Generated<string>;
  tip_minor: Generated<string>;
  discount_minor: Generated<string>;
  receipt_kind: 'demo' | 'manual';
  created_at: Timestamp;
  published_at: NullableTimestamp;
}
interface AllocationTable {
  workspace_id: string;
  expense_id: string;
  person_id: string;
  amount_minor: Money;
}
interface RequestTable {
  id: string;
  workspace_id: string;
  expense_id: string;
  debtor_id: string;
  payee_id: string;
  amount_minor: Money;
  status: Generated<RequestStatus>;
  version: Generated<number>;
  issue_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
interface ReviewTable {
  id: string;
  workspace_id: string;
  session_id: string;
  payer_id: string;
  payee_id: string;
  request_id: string | null;
  request_version: number | null;
  kind: 'request' | 'send';
  amount_minor: Money;
  fee_minor: Generated<string>;
  currency: Generated<'USD'>;
  source_id: Generated<'demo-balance'>;
  note: string;
  digest: string;
  expires_at: Timestamp;
  created_at: Timestamp;
}
interface ConsentTable {
  id: string;
  workspace_id: string;
  review_id: string;
  session_id: string;
  actor_id: string;
  review_digest: string;
  policy_version: Generated<'demo-zero-fee-v1'>;
  created_at: Timestamp;
}
interface OperationTable {
  id: string;
  workspace_id: string;
  review_id: string;
  consent_id: string;
  payer_id: string;
  payee_id: string;
  request_id: string | null;
  kind: 'request' | 'send';
  amount_minor: Money;
  note: string;
  status: Generated<OperationStatus>;
  provider: Generated<'simulator'>;
  ready_at: Timestamp;
  created_at: Timestamp;
  completed_at: NullableTimestamp;
}
interface SettlementTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  amount_minor: Money;
  created_at: Timestamp;
}
interface ActivityTable {
  id: string;
  workspace_id: string;
  user_id: string;
  person_id: string | null;
  expense_id: string | null;
  operation_id: string | null;
  type: 'split_created' | 'payment_sent' | 'payment_received' | 'request_canceled' | 'issue_raised';
  title: string;
  description: string;
  emoji: string;
  amount_minor: string | null;
  created_at: Timestamp;
}
interface IdempotencyTable {
  workspace_id: string;
  actor_id: string;
  scope: string;
  key: string;
  request_hash: string;
  resource_id: string;
  created_at: Timestamp;
}

export interface Database {
  receipt_captures: ReceiptCaptureTable;
  receipt_daily_budget: ReceiptBudgetTable;
  phone_verification_challenges: PhoneChallengeTable;
  phone_proof_claims: PhoneProofTable;
  demo_workspaces: WorkspaceTable;
  people: PeopleTable;
  demo_sessions: SessionTable;
  expenses: ExpenseTable;
  expense_allocations: AllocationTable;
  payment_requests: RequestTable;
  payment_reviews: ReviewTable;
  payment_consents: ConsentTable;
  operations: OperationTable;
  settlement_events: SettlementTable;
  activity: ActivityTable;
  api_idempotency: IdempotencyTable;
}
