import type { CreateExpenseInput } from '@tallie/db/contracts';

export type MessageMethod = 'equal' | 'items' | 'custom';

export interface MessageIdentity {
  accountId: string;
  personId: string;
  sessionId: string;
  bindingEpoch: number;
  phone: string;
}

export interface MessageDraft {
  id: string;
  version: number;
  title: string;
  totalMinor: string | null;
  method: MessageMethod | null;
  participantNames: string[];
  participants: { personId: string; name: string }[];
  unresolvedNames: string[];
  receiptId: string | null;
  receiptStatus: 'processing' | 'ready' | 'needs_review' | 'failed' | null;
  expenseId: string | null;
  /** Retained, previously approved web details for safe lost-response recovery. */
  publicationPending?: boolean;
  publicationInput?: CreateExpenseInput | null;
  reviewDigest: string | null;
  reviewExpiresAt: string | null;
  stage: 'details' | 'participants' | 'method' | 'review' | 'closed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MessagesState {
  available: boolean;
  sendingEnabled: boolean;
  grant: {
    id: string;
    maskedPhone: string;
    expiresAt: string;
    stopped: boolean;
    notifications: boolean;
  } | null;
  drafts: MessageDraft[];
}

export interface InboundMessage {
  handle: string;
  from: string;
  line: string;
  content: string;
  mediaUrl: string | null;
  occurredAt: string;
  updatedAt: string;
  outbound: boolean;
  status: string;
  group: boolean;
  optedOut: boolean;
  replyTo: string | null;
}

export interface MessagingTransport {
  retrieve(handle: string): Promise<InboundMessage>;
  send(input: { from: string; to: string; content: string; callbackUrl: string }): Promise<{
    handle: string;
    status: 'queued' | 'sent' | 'delivered';
  }>;
}

export interface MessagingHooks {
  /** Recheck the current real account, verified phone, person and binding epoch. */
  validateIdentity(identity: MessageIdentity): Promise<boolean>;
  /** Exact, unambiguous existing contacts only; never infer a recipient from a name. */
  resolveContacts(
    identity: MessageIdentity,
    names: string[],
  ): Promise<{
    participants: { personId: string; name: string }[];
    unresolvedNames: string[];
  }>;
  /** Must be idempotent by messageId and bind the receipt to this real account. */
  ingestReceipt?(input: {
    identity: MessageIdentity;
    draftId: string;
    messageId: string;
    bytes: Buffer;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<{ receiptId: string }>;
  readReceipt?(
    identity: MessageIdentity,
    receiptId: string,
  ): Promise<{
    status: 'queued' | 'processing' | 'review_needed' | 'failed';
    title?: string;
    totalMinor?: string | null;
    currency?: 'USD' | 'unknown' | 'unsupported';
    warnings?: string[];
  }>;
  /** The implementation must enforce a permanent draftId idempotency key atomically. */
  publishEqualSplit?(input: {
    identity: MessageIdentity;
    draftId: string;
    version: number;
    reviewDigest: string;
    title: string;
    totalMinor: string;
    participantIds: string[];
  }): Promise<{ expenseId: string }>;
  /** Recheck canonical request status and recipient consent before notification dispatch. */
  notificationEligible?(accountId: string, reference: string): Promise<boolean>;
}

export class MessagingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = 'MessagingError';
  }
}

export class DeliveryError extends Error {
  constructor(public readonly outcome: 'rejected' | 'rate_limited' | 'unknown') {
    super(`Message delivery ${outcome}`);
    this.name = 'DeliveryError';
  }
}
