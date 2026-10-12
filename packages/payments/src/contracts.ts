/** Browser-safe sandbox setup. No provider identifiers or money-movement authority. */
export type SandboxConnectionStatus =
  'prepared' | 'inviting' | 'accepting' | 'verifying' | 'connected' | 'unknown' | 'blocked';

export interface SandboxAccountState {
  environment: 'sandbox';
  available: boolean;
  moneyMovementEnabled: false;
  connection: {
    id: string;
    status: SandboxConnectionStatus;
    retryAllowed: boolean;
    balances: {
      id: string;
      currency: 'USD';
      availableMinor: string | null;
      totalMinor: string | null;
    }[];
    updatedAt: string;
  } | null;
}

export interface ProductionConnectionState {
  available: boolean;
  environment: 'production';
  moneyMovementEnabled: false;
  connection: {
    status: 'inviting' | 'pending' | 'verifying' | 'connected' | 'unknown' | 'blocked' | 'expired';
    invitationUrl: string | null;
    invitationExpiresAt: string | null;
  } | null;
}
export type { OwnerPilotPayment, OwnerPilotState } from './owner-pilot-contracts';
