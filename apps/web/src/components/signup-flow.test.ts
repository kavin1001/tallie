import { describe, expect, it } from 'vitest';
import type { IdentityAccount, IdentityState, SignupChallenge } from '@tallie/identity/contracts';
import { shouldResumeSignup, signupStep } from './signup-flow';

const now = Date.parse('2026-09-26T12:00:00Z');
const later = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const account: IdentityAccount = {
  id: 'unfinished-account',
  name: 'Taylor',
  maskedPhone: '+1 ••• ••• 0100',
  passkeyCount: 0,
  recoveryCodesRemaining: 0,
  assurance: 'onboarding',
  ready: false,
  enrollmentExpiresAt: later(10),
};
const proof: SignupChallenge = {
  id: 'verified-proof',
  purpose: 'signup',
  completionMode: null,
  status: 'verified',
  maskedPhone: account.maskedPhone,
  expiresAt: later(5),
  delivery: null,
};
const state = (patch: Partial<IdentityState> = {}): IdentityState => ({
  available: true,
  account: null,
  challenge: null,
  ...patch,
});

describe('interrupted signup routing', () => {
  it('returns a verified browser to its name form after reload', () => {
    const saved = state({ challenge: proof });
    expect(shouldResumeSignup(saved, now)).toBe(true);
    expect(signupStep(saved, false, now)).toBe('details');
  });

  it('resumes an outstanding message without creating another phone proof', () => {
    const saved = state({ challenge: { ...proof, status: 'pending' } });
    expect(shouldResumeSignup(saved, now)).toBe(true);
    expect(signupStep(saved, false, now)).toBe('verification');
  });

  it('resumes first passkey enrollment with the existing restricted account', () => {
    const saved = state({ account, challenge: { ...proof, status: 'complete' } });
    expect(shouldResumeSignup(saved, now)).toBe(true);
    expect(signupStep(saved, false, now)).toBe('passkey');
  });

  it('asks for fresh phone proof when the enrollment deadline is reached', () => {
    const saved = state({ account });
    const deadline = Date.parse(account.enrollmentExpiresAt!);
    expect(signupStep(saved, false, deadline - 1)).toBe('passkey');
    expect(signupStep(saved, false, deadline)).toBe('phone');
    expect(shouldResumeSignup(saved, deadline)).toBe(true);
  });

  it('keeps a renewed pending or verified proof ahead of the old enrollment session on reload', () => {
    const stale = { ...account, enrollmentExpiresAt: later(-1) };
    expect(
      signupStep(state({ account: stale, challenge: { ...proof, status: 'pending' } }), false, now),
    ).toBe('verification');
    expect(signupStep(state({ account: stale, challenge: proof }), false, now)).toBe('details');
  });

  it('resumes a requested reverification even while the original enrollment is still fresh', () => {
    const pending = state({ account, challenge: { ...proof, status: 'pending' } });
    expect(signupStep(pending, false, now)).toBe('verification');
    expect(signupStep(state({ account, challenge: proof }), false, now)).toBe('details');
  });

  it('restores a cached completion after a lost response without replaying phone verification', () => {
    const saved = state({
      challenge: { ...proof, status: 'complete', completionMode: 'signup' },
    });
    expect(shouldResumeSignup(saved, now)).toBe(true);
    expect(signupStep(saved, false, now)).toBe('details');
    expect(signupStep(saved, false, Date.parse(proof.expiresAt))).toBe('phone');
  });

  it('returns to phone entry when unconsumed verification expires', () => {
    const saved = state({ challenge: proof });
    expect(signupStep(saved, false, Date.parse(proof.expiresAt))).toBe('phone');
    expect(shouldResumeSignup(saved, Date.parse(proof.expiresAt))).toBe(false);
  });

  it('honors an explicit request to verify again without signing out', () => {
    expect(signupStep(state({ account }), true, now)).toBe('phone');
  });

  it('keeps channel proofs out of signup and does not reopen established accounts', () => {
    expect(shouldResumeSignup(state({ challenge: { ...proof, purpose: 'channel' } }), now)).toBe(
      false,
    );
    expect(signupStep(state({ challenge: { ...proof, purpose: 'channel' } }), false, now)).toBe(
      'phone',
    );
    expect(
      shouldResumeSignup(
        state({ account: { ...account, ready: true, assurance: 'passkey' } }),
        now,
      ),
    ).toBe(false);
  });
});
