import type { IdentityState } from '@tallie/identity/contracts';

export type SignupStep = 'phone' | 'verification' | 'details' | 'passkey';

export function shouldResumeSignup(state: IdentityState, now = Date.now()): boolean {
  if (state.account) return !state.account.ready;
  const challenge = state.challenge;
  return Boolean(
    challenge?.purpose === 'signup' &&
    ['creating', 'pending', 'verified', 'complete'].includes(challenge.status) &&
    Date.parse(challenge.expiresAt) > now,
  );
}

/** Resume from server evidence; a page reload must not restart or skip a verified step. */
export function signupStep(
  state: IdentityState,
  verifyAgain: boolean,
  now = Date.now(),
): SignupStep {
  const challenge = state.challenge?.purpose === 'signup' ? state.challenge : null;
  const proofCurrent = challenge && Date.parse(challenge.expiresAt) > now;

  // A fresh proof takes precedence over the older restricted enrollment session.
  if (proofCurrent && ['creating', 'pending'].includes(challenge.status)) return 'verification';
  if (proofCurrent && challenge.status === 'verified') return 'details';

  if (state.account && !state.account.ready)
    return !verifyAgain &&
      state.account.enrollmentExpiresAt &&
      Date.parse(state.account.enrollmentExpiresAt) > now
      ? 'passkey'
      : 'phone';

  // A lost completion response can be retried with its original details.
  if (proofCurrent && challenge.status === 'complete') return 'details';
  return 'phone';
}
