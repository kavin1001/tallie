/** JSON-only browser contract. Amounts are whole cents; null means unreadable/absent. */
export type ReceiptStatus = 'queued' | 'processing' | 'review_needed' | 'failed';
export type ReceiptContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ReceiptProposal {
  schemaVersion: 1;
  title: string;
  currency: 'USD' | 'unknown' | 'unsupported';
  items: {
    id: string;
    description: string;
    quantity: string | null;
    /** Line total, never unit price. */
    amountMinor: string | null;
  }[];
  subtotalMinor: string | null;
  totalMinor: string | null;
  taxMinor: string | null;
  tipMinor: string | null;
  discountMinor: string | null;
  serviceChargeMinor: string | null;
  warnings: string[];
  confidence: 'high' | 'medium' | 'low';
  /** Only true when every component is known and exact integer arithmetic agrees. */
  reconciled: boolean;
}

export interface ReceiptDraft {
  id: string;
  status: ReceiptStatus;
  proposal: ReceiptProposal | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  expiresAt: string;
  /** Authenticated URL, only the uploading session may read this image. */
  imageUrl: string | null;
}

export interface ReceiptUpload {
  contentBase64: string;
  contentType: ReceiptContentType;
}

export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_MAX_PIXELS = 24_000_000;
export const RECEIPT_MAX_LINES = 100;
