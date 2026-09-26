/** A development phone-possession test. It grants no account or payment authority. */
export interface PhoneChallenge {
  id: string;
  purpose: 'connect_test';
  status: 'creating' | 'pending' | 'verified' | 'expired' | 'canceled' | 'failed' | 'needs_retry';
  maskedPhone: string;
  expiresAt: string;
  verifiedAt: string | null;
  delivery: { number: string; code: string; smsDeepLink: string } | null;
}

export interface PhoneVerificationState {
  available: boolean;
  challenge: PhoneChallenge | null;
}
