/** Public JSON contracts. This module must stay free of runtime/server imports. */
export type MinorUnits = string;
export type SplitMethod = 'equal' | 'custom' | 'items';
export type RequestStatus = 'open' | 'processing' | 'paid' | 'canceled' | 'issue';
export type OperationStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type Category = 'dinner' | 'travel' | 'coffee' | 'groceries' | 'tickets' | 'other';

export interface Person {
  id: string;
  name: string;
  firstName: string;
  initials: string;
  color: string;
  venmoHandle: string | null;
}

export interface Allocation {
  person: Person;
  amountMinor: MinorUnits;
  requestId: string | null;
  status: RequestStatus | 'self' | 'no_payment';
}

export interface ExpenseItem {
  id: string;
  name: string;
  amountMinor: MinorUnits;
  participantIds: string[];
}

export interface ExpenseSummary {
  id: string;
  title: string;
  emoji: string;
  category: Category;
  totalMinor: MinorUnits;
  currency: 'USD';
  method: SplitMethod;
  paidBy: Person;
  participants: Allocation[];
  createdAt: string;
  status: 'open' | 'settled' | 'canceled';
  version: number;
  items: ExpenseItem[];
  subtotalMinor: MinorUnits;
  taxMinor: MinorUnits;
  tipMinor: MinorUnits;
  discountMinor: MinorUnits;
  receiptKind: 'demo' | 'manual';
}

export interface PaymentRequest {
  id: string;
  expenseId: string;
  title: string;
  emoji: string;
  /** Person requesting/receiving this payment. */
  from: Person;
  /** Person being asked to pay. */
  to: Person;
  amountMinor: MinorUnits;
  currency: 'USD';
  status: RequestStatus;
  version: number;
  createdAt: string;
  issueReason: string | null;
  allowedActions: ('review_payment' | 'cancel_request' | 'raise_issue' | 'view_expense')[];
}

export interface ExpenseDetailData {
  expense: ExpenseSummary;
  /** Complete requests for this expense involving the current payer or payee. */
  requests: PaymentRequest[];
}

export interface Activity {
  id: string;
  type: 'split_created' | 'payment_sent' | 'payment_received' | 'request_canceled' | 'issue_raised';
  title: string;
  description: string;
  emoji: string;
  amountMinor: MinorUnits | null;
  person: Person | null;
  expenseId: string | null;
  operationId: string | null;
  createdAt: string;
}

export interface PersonBalance {
  personId: string;
  owedToYouMinor: MinorUnits;
  owingMinor: MinorUnits;
}

export interface Dashboard {
  mode: 'demo';
  user: Person;
  people: Person[];
  /** Complete outstanding totals, independent of paginated or bounded request lists. */
  personBalances: PersonBalance[];
  expenses: ExpenseSummary[];
  requests: PaymentRequest[];
  activity: Activity[];
  summary: {
    owedToYouMinor: MinorUnits;
    owingMinor: MinorUnits;
    settledMinor: MinorUnits;
  };
  capabilities: {
    natural: false;
    imessage: false;
    receiptUpload: boolean;
    phoneVerification?: boolean;
    venmo: false;
  };
}

export interface PaymentReview {
  id: string;
  requestId: string | null;
  requestVersion: number | null;
  kind: 'request' | 'send';
  amountMinor: MinorUnits;
  feeMinor: '0';
  totalMinor: MinorUnits;
  currency: 'USD';
  /** Money direction: from is the person paying; to is receiving. */
  from: Person;
  to: Person;
  note: string;
  source: { id: 'demo-balance'; label: 'Demo balance' };
  reviewDigest: string;
  expiresAt: string;
  mode: 'demo';
}

export interface Operation {
  id: string;
  status: OperationStatus;
  kind: 'request' | 'send';
  amountMinor: MinorUnits;
  currency: 'USD';
  from: Person;
  to: Person;
  requestId: string | null;
  expenseId: string | null;
  note: string;
  createdAt: string;
  completedAt: string | null;
  mode: 'demo';
}

export interface CreateExpenseInput {
  title: string;
  emoji: string;
  category: Category;
  totalMinor: MinorUnits;
  participantIds: string[];
  method: SplitMethod;
  shares?: { participantId: string; amountMinor: MinorUnits }[] | undefined;
  items?: ExpenseItem[] | undefined;
  taxMinor?: MinorUnits | undefined;
  tipMinor?: MinorUnits | undefined;
  discountMinor?: MinorUnits | undefined;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

export type ApiResponse<T> = { data: T } | { error: ApiError };
