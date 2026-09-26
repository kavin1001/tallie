export interface AccountPrincipal {
  userId: string;
  sessionId: string;
  phoneHash: string;
  displayName: string;
}

export interface IdentityAccount {
  id: string;
  name: string;
  maskedPhone: string;
  passkeyCount: number;
  recoveryCodesRemaining: number;
  assurance: 'onboarding' | 'passkey' | 'recovery';
  ready: boolean;
}

export interface SignupChallenge {
  id: string;
  purpose: 'signup' | 'channel';
  /** Only the owning browser receives the mode of a successfully cached completion. */
  completionMode: 'signup' | 'recovery' | null;
  status: 'creating' | 'pending' | 'verified' | 'expired' | 'failed' | 'needs_retry' | 'complete';
  maskedPhone: string;
  expiresAt: string;
  delivery: { number: string; code: string; smsDeepLink: string } | null;
}

export interface IdentityState {
  available: boolean;
  account: IdentityAccount | null;
  challenge: SignupChallenge | null;
}

export interface SignupComplete {
  account: IdentityAccount;
}
