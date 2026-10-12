/** Browser-safe account collaboration contracts. No financial payment authority. */
import type { Category, CreateExpenseInput, ExpenseItem, SplitMethod } from '@tallie/db/contracts';

export interface SocialContact {
  id: string;
  label: string;
  maskedPhone: string;
  /** Connected only after the intended person accepts an invitation. */
  status: 'invitation_needed' | 'connected';
  createdAt: string;
}

export interface SocialShare {
  id: string;
  /** Sender's contact UUID, or the sender user UUID for their own share. */
  participantId: string;
  name: string;
  amountMinor: string;
  isYou: boolean;
  status: 'self' | 'no_payment' | 'invite_ready' | 'payment_setup_pending' | 'canceled';
  /** Test settlement is a separate projection; it can never settle a manual expense. */
  sandboxPayment?: {
    status: 'unpaid' | 'processing' | 'unknown' | 'paid' | 'failed' | 'returned';
    canCancel: boolean;
  };
}

export interface SocialExpense {
  id: string;
  title: string;
  emoji: string;
  category: Category;
  totalMinor: string;
  currency: 'USD';
  method: SplitMethod;
  paidByName: string;
  isOwner: boolean;
  shares: SocialShare[];
  items: ExpenseItem[];
  subtotalMinor: string;
  taxMinor: string;
  tipMinor: string;
  discountMinor: string;
  createdAt: string;
  paymentEnvironment: 'manual' | 'sandbox';
  /** Every real obligation remains blocked while Natural is unavailable. */
  paymentsEnabled: false;
}

export type CreateSocialExpense = CreateExpenseInput & {
  /** Explicit opt-in on new expenses only. Existing obligations stay manual. */
  paymentEnvironment?: 'manual' | 'sandbox' | undefined;
};

export interface SocialDashboard {
  userId: string;
  displayName: string;
  contacts: SocialContact[];
  expenses: SocialExpense[];
  summary: { owedToYouMinor: string; owingMinor: string };
  sandboxSummary: { owedToYouMinor: string; owingMinor: string };
  paymentsEnabled: false;
  capabilities: { receiptUpload: boolean; sandboxPayments: boolean };
}

export interface SocialInvitation {
  id: string;
  contactId: string;
  expenseId: string | null;
  /** Token remains in the URL fragment to avoid server and link-preview logs. */
  url: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'revoked' | 'expired';
}

export interface InvitationInspection {
  status: 'available' | 'unavailable';
  purpose: 'join_tallie';
}

export interface InvitationClaim {
  contactId: string;
  expenseId: string | null;
  connected: true;
}
