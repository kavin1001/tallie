import type { Selectable } from 'kysely';
import type { Database } from '@tallie/db';
import type { ReceiptDraft, ReceiptProposal } from './contracts';

const errorMessages: Record<string, string> = {
  NOT_A_RECEIPT: 'Choose a receipt photo, or enter the expense manually.',
  EXTRACTION_INVALID:
    'We could not read this receipt reliably. Try a clearer photo or enter it manually.',
  IMAGE_UNREADABLE:
    'This photo could not be opened safely. Try a smaller JPEG, PNG, or WebP image.',
  UNSUPPORTED_IMAGE: 'Choose a JPEG, PNG, or WebP receipt photo up to 8 MB.',
  IMAGE_CHANGED: 'This photo changed during processing. Upload it again.',
  RECEIPT_BUDGET_REACHED:
    'Receipt reading has reached today’s limit. You can still enter the expense manually.',
  PROVIDER_UNAVAILABLE:
    'Receipt reading is temporarily unavailable. You can enter the expense manually.',
  PROVIDER_INTERRUPTED: 'Receipt reading was interrupted. Try again or enter the expense manually.',
  PROCESSING_INTERRUPTED:
    'Receipt reading was interrupted. Try again or enter the expense manually.',
};

export function toReceiptDraft(row: Selectable<Database['receipt_captures']>): ReceiptDraft {
  return {
    id: row.id,
    status: row.status,
    proposal: row.proposal as ReceiptProposal | null,
    error:
      row.status === 'failed'
        ? {
            code: row.error_code ?? 'PROCESSING_INTERRUPTED',
            message: errorMessages[row.error_code ?? ''] ?? errorMessages.PROCESSING_INTERRUPTED!,
          }
        : null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    imageUrl: row.normalized_hash ? `/api/receipts/${row.id}/image` : null,
  };
}
