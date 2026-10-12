export interface OwnerPilotPayment {
  id: string;
  status: string;
  amountMinor: number;
  currency: 'USD';
  senderPartyId: string;
  senderAgentId: string | null;
  recipientPartyId: string | null;
  recipientAgentId: string | null;
  tags: Readonly<Record<string, unknown>>;
  feeMinor: number | null;
}

/** Browser projection: provider parties, wallets, keys and phone data stay server-side. */
export interface OwnerPilotState {
  available: boolean;
  recipientHandle: string;
  amountMinor: number;
  currency: 'USD';
  availableMinor: number | null;
  review: {
    id: string;
    recipientHandle: string;
    amountMinor: number;
    currency: 'USD';
    expiresAt: string;
  } | null;
  transfer: {
    id: string;
    status: string;
    recipientHandle: string;
    amountMinor: number;
    currency: 'USD';
    feeMinor: number | null;
    needsStatusCheck: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
}
