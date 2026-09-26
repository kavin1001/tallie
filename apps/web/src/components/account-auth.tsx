'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Fingerprint,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react';
import type { IdentityState, SignupChallenge, SignupComplete } from '@tallie/identity/contracts';
import { identityClient } from '@tallie/identity/client';
import { api, errorMessage, RequestError } from '@/lib/client';
import { Button } from './ui';
import { Flower, Wordmark } from './brand';

export function AccountAuth({
  state,
  onState,
  onBack,
  invited,
}: {
  state: IdentityState;
  onState: (state: IdentityState) => void;
  onBack: () => void;
  invited: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [recovery, setRecovery] = useState(state.challenge?.completionMode === 'recovery');
  const [resumePhone, setResumePhone] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const active = useRef(true);
  const attempt = useRef<{ phone: string; key: string } | null>(null);
  const challenge = state.challenge?.purpose === 'signup' ? state.challenge : null;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function run(label: string, task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    try {
      await task();
    } catch (e) {
      if (active.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
      if (active.current) setBusy(null);
    }
  }
  async function refresh() {
    const next = await api<IdentityState>('/api/identity/state');
    if (active.current) onStateRef.current(next);
  }

  const pending = challenge?.status === 'pending' || challenge?.status === 'creating';
  useEffect(() => {
    if (!pending || !challenge || busy) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const next = await api<SignupChallenge>(
          '/api/identity/signup/check',
          { challengeId: challenge.id },
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted) onStateRef.current({ ...state, challenge: next });
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!abort.signal.aborted) setPollTick((tick) => tick + 1);
      }
    }, 4000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [pending, challenge, busy, state, pollTick]);

  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function passkeySignIn() {
    await run('passkey', async () => {
      const result = await identityClient.signIn.passkey();
      if (result.error)
        throw new Error('Your passkey wasn’t used. Try again, or use account recovery.');
      await refresh();
    });
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    await run('phone', async () => {
      const digits = phone.replace(/\D/g, '');
      const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      if (!attempt.current && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalized))
        throw new Error('Enter your 10-digit US mobile number.');
      attempt.current ??= { phone: normalized, key: crypto.randomUUID() };
      try {
        const next = await api<SignupChallenge>(
          '/api/identity/signup/start',
          { phone: attempt.current.phone },
          attempt.current.key,
        );
        if (!active.current) return;
        onStateRef.current({ ...state, challenge: next });
        setUncertain(false);
        attempt.current = null;
      } catch (e) {
        if (e instanceof RequestError && e.status >= 400 && e.status < 500) {
          attempt.current = null;
          setUncertain(false);
        } else setUncertain(true);
        throw e;
      }
    });
  }

  async function complete(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    await run('complete', async () => {
      try {
        const result = await api<SignupComplete>(
          recovery ? '/api/identity/recovery/complete' : '/api/identity/signup/complete',
          recovery
            ? { challengeId: challenge.id, recoveryCode: code }
            : { challengeId: challenge.id, name: name.trim() },
          undefined,
          undefined,
          state.account?.id,
        );
        if (active.current) {
          setResumePhone(false);
          setCode('');
          onStateRef.current({ ...state, account: result.account, challenge: null });
        }
      } catch (e) {
        if (e instanceof RequestError && e.code === 'ACCOUNT_RECOVERY_REQUIRED') {
          setRecovery(true);
          throw new Error(
            'An account already uses this number. Sign in with its passkey, or enter a saved recovery code.',
          );
        }
        throw e;
      }
    });
  }

  async function enrollPasskey() {
    await run('enroll', async () => {
      const result = await identityClient.passkey.addPasskey({
        name: 'My Tallie passkey',
        ...(state.account
          ? { fetchOptions: { headers: { 'X-Tallie-Account': state.account.id } } }
          : {}),
      });
      if (result.error)
        throw new Error(
          'We couldn’t save that passkey. Try again on this device, or resume signup on a supported device.',
        );
      await refresh();
    });
  }

  function startAgain() {
    attempt.current = null;
    setUncertain(false);
    setError('');
    onStateRef.current({ ...state, challenge: null });
  }

  const secondsLeft = Math.max(
    0,
    Math.ceil((new Date(challenge?.expiresAt ?? now).getTime() - now) / 1000),
  );
  const delivery = pending && secondsLeft > 0 ? challenge?.delivery : null;
  const onboarding = state.account && !state.account.ready && !resumePhone;

  return (
    <div className="account-auth-shell">
      <header className="account-auth-header">
        <Wordmark />
        <button type="button" className="text-action" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </button>
      </header>
      <main className="account-auth-main">
        <section className="account-auth-card" aria-busy={Boolean(busy)}>
          <span className="account-step">
            {invited ? 'A GOOD TIME IS WAITING FOR YOU' : 'A LITTLE LESS SETTLING UP'}
          </span>
          {onboarding ? (
            <>
              <div className="account-auth-symbol">
                <Fingerprint size={31} strokeWidth={1.3} />
              </div>
              <h1>
                Your Tallie.
                <br />
                <em>Your fingerprint.</em>
              </h1>
              <p>
                One last touch, {state.account!.name.split(' ')[0]}. A passkey keeps your shared
                moments yours.
              </p>
              <div className="account-auth-actions">
                <Button
                  size="lg"
                  fullWidth
                  onClick={() => void enrollPasskey()}
                  loading={busy === 'enroll'}
                  disabled={Boolean(busy)}
                >
                  Create my passkey <Fingerprint size={19} />
                </Button>
              </div>
              <p className="fine-print">
                Use Face ID, Touch ID, or your device PIN. Tallie never receives your fingerprint or
                face data.
              </p>
              <button
                type="button"
                className="text-action"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('resume', async () => {
                    setResumePhone(true);
                    onStateRef.current({ ...state, challenge: null });
                  })
                }
              >
                Need to verify your number again?
              </button>
            </>
          ) : challenge?.status === 'verified' || challenge?.status === 'complete' ? (
            <>
              <div className="account-auth-symbol">
                <Check size={28} />
              </div>
              <h1>
                {recovery ? 'Welcome back.' : 'A name to the'}
                <br />
                {!recovery && <em>good times.</em>}
              </h1>
              <p>
                {recovery
                  ? 'Your number checks out. Use one saved recovery code to restore access.'
                  : 'Your number checks out. What should your friends call you?'}
              </p>
              <form onSubmit={(e) => void complete(e)}>
                <div className="form-field">
                  <label htmlFor="account-name">{recovery ? 'Recovery code' : 'Your name'}</label>
                  <input
                    id="account-name"
                    autoComplete={recovery ? 'off' : 'name'}
                    maxLength={recovery ? 64 : 60}
                    value={recovery ? code : name}
                    onChange={(e) => (recovery ? setCode(e.target.value) : setName(e.target.value))}
                    placeholder={recovery ? 'Your saved recovery code' : 'First and last name'}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  fullWidth
                  loading={busy === 'complete'}
                  disabled={Boolean(busy)}
                >
                  {recovery ? 'Restore my account' : 'Make myself at home'} <ArrowRight size={17} />
                </Button>
              </form>
              <button
                type="button"
                className="text-action"
                onClick={() => void passkeySignIn()}
                disabled={Boolean(busy)}
              >
                Already have a passkey? Sign in
              </button>
            </>
          ) : pending ? (
            <>
              <div className="account-auth-symbol">
                <MessageCircle size={29} strokeWidth={1.5} />
              </div>
              <h1>
                Send a little
                <br />
                <em>hello.</em>
              </h1>
              <p>Send this code from {challenge!.maskedPhone}. Then come right back here.</p>
              {delivery ? (
                <>
                  <div className="account-verification-slip">
                    <span>YOUR MESSAGE</span>
                    <strong className="phone-code">{delivery.code}</strong>
                    <p>Send to {delivery.number}</p>
                    <small>
                      {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}{' '}
                      remaining
                    </small>
                  </div>
                  <a
                    href={delivery.smsDeepLink}
                    className="ui-button ui-button--primary ui-button--lg ui-button--full"
                  >
                    Open Messages <ArrowRight size={18} />
                  </a>
                  <p className="fine-print">
                    Tap Send yourself. Opening Messages doesn’t verify your number.
                  </p>
                </>
              ) : (
                <p role="status" className="processing-note">
                  <span className="ui-spinner" />
                  {secondsLeft === 0 ? 'Checking the code’s status…' : 'Preparing your message…'}
                </p>
              )}
              <Button
                variant="ghost"
                fullWidth
                loading={busy === 'check'}
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('check', async () => {
                    const next = await api<SignupChallenge>('/api/identity/signup/check', {
                      challengeId: challenge!.id,
                    });
                    if (active.current) onStateRef.current({ ...state, challenge: next });
                  })
                }
              >
                I’ve sent it
              </Button>
              <button
                type="button"
                className="text-action"
                disabled={Boolean(busy)}
                onClick={startAgain}
              >
                Use another number
              </button>
            </>
          ) : (
            <>
              <div className="account-auth-symbol">
                <Flower />
              </div>
              <h1>
                {recovery ? 'Let’s get you' : 'You bring the'}
                <br />
                <em>{recovery ? 'back in.' : 'good company.'}</em>
              </h1>
              <p>
                {recovery
                  ? 'First, verify your number. Then use a saved recovery code.'
                  : 'We’ll handle the little things. Start with your mobile number.'}
              </p>
              {challenge && (
                <p className="form-hint">
                  {challenge.status === 'expired'
                    ? 'That code has expired. Start again when you’re ready.'
                    : 'We couldn’t finish that verification. Please try again.'}
                </p>
              )}
              <form onSubmit={(e) => void start(e)}>
                <div className="form-field">
                  <label htmlFor="signup-phone">Your mobile number</label>
                  <div className="phone-input">
                    <span aria-hidden="true">+1</span>
                    <input
                      id="signup-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      maxLength={24}
                      placeholder="Your 10-digit number"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      disabled={Boolean(busy) || uncertain}
                      required
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  size="lg"
                  fullWidth
                  loading={busy === 'phone'}
                  disabled={Boolean(busy) || !state.available}
                >
                  {uncertain ? 'Retry safely' : 'Continue with Messages'} <ArrowRight size={17} />
                </Button>
              </form>
              <p className="fine-print">
                You’ll send a short code to verify your number. Standard messaging rates may apply.
              </p>
              <div className="account-auth-divider">
                <span />
                ALREADY HERE?
                <span />
              </div>
              <Button
                variant="secondary"
                fullWidth
                onClick={() => void passkeySignIn()}
                loading={busy === 'passkey'}
                disabled={Boolean(busy)}
              >
                Sign in with a passkey <Fingerprint size={18} />
              </Button>
              <button
                type="button"
                className="text-action"
                disabled={Boolean(busy)}
                onClick={() => {
                  setRecovery(!recovery);
                  setError('');
                }}
              >
                {recovery ? 'Back to creating an account' : 'Need help getting back in?'}
              </button>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!state.available && (
            <p className="form-hint">Account setup isn’t connected in this environment yet.</p>
          )}
          {invited && (
            <p className="account-invite-note">
              <ShieldCheck size={14} />
              Your invitation stays with you through signup.
            </p>
          )}
        </section>
        <aside className="account-auth-aside">
          <span className="account-orbit">
            <Flower />
          </span>
          <p>
            For the people
            <br />
            you do <em>life</em> with.
          </p>
          <small>Good memories. Clear numbers.</small>
        </aside>
      </main>
    </div>
  );
}
