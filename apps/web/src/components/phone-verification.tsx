'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Copy, MessageCircle, ShieldCheck } from 'lucide-react';
import type { PhoneChallenge, PhoneVerificationState } from '@tallie/channels/contracts';
import { api, errorMessage, RequestError } from '@/lib/client';
import { Button, Dialog } from './ui';

type Action = 'loading' | 'creating' | 'checking' | 'canceling';
type Attempt = { phone: string; key: string };

function normalizePhone(value: string): string | null {
  if (!/^[+\d\s().-]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

/** A user-initiated development test. Success grants no login or payment authority. */
export function PhoneVerification({ onClose }: { onClose: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [challenge, setChallenge] = useState<PhoneChallenge | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [sessionLost, setSessionLost] = useState(false);
  const [uncertain, setUncertain] = useState<'create' | 'cancel' | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const inputId = useId();
  const hintId = useId();

  const clearInaccessibleTest = useCallback((reason: unknown): boolean => {
    if (!(reason instanceof RequestError) || ![401, 403, 404].includes(reason.status)) return false;
    setChallenge(null);
    setAvailable(false);
    setSessionLost(true);
    setUncertain(null);
    setPhone('');
    attempt.current = null;
    return true;
  }, []);

  // One request at a time; abort and generation checks prevent an older result from
  // replacing a canceled test or writing state after this dialog unmounts.
  const run = useCallback(
    async <T,>(
      action: Action,
      task: (signal: AbortSignal) => Promise<T>,
      success: (result: T) => void,
      failure: (reason: unknown) => void = (reason) => setError(errorMessage(reason)),
    ) => {
      if (!mounted.current || request.current) return;
      const controller = new AbortController();
      const version = ++generation.current;
      request.current = controller;
      setBusy(action);
      setError('');
      try {
        const result = await task(controller.signal);
        if (mounted.current && generation.current === version) success(result);
      } catch (reason) {
        if (mounted.current && generation.current === version && !controller.signal.aborted)
          failure(reason);
      } finally {
        if (mounted.current && generation.current === version) {
          request.current = null;
          setBusy(null);
        }
      }
    },
    [],
  );

  const applyState = useCallback((state: PhoneVerificationState) => {
    setAvailable(state.available);
    setChallenge(state.challenge);
  }, []);

  const resume = useCallback(
    () =>
      run(
        'loading',
        (signal) =>
          api<PhoneVerificationState>('/api/phone-verifications', undefined, undefined, signal),
        applyState,
        (reason) => {
          if (!clearInaccessibleTest(reason)) setError(errorMessage(reason));
        },
      ),
    [applyState, clearInaccessibleTest, run],
  );

  useEffect(() => {
    mounted.current = true;
    void resume();
    return () => {
      mounted.current = false;
      generation.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, [resume]);

  const check = useCallback(
    (current: PhoneChallenge) =>
      current.status === 'creating'
        ? run(
            'checking',
            (signal) =>
              api<PhoneVerificationState>('/api/phone-verifications', undefined, undefined, signal),
            applyState,
            (reason) => {
              if (!clearInaccessibleTest(reason)) setError(errorMessage(reason));
            },
          )
        : run(
            'checking',
            (signal) =>
              api<PhoneChallenge>(
                `/api/phone-verifications/${current.id}/check`,
                {},
                undefined,
                signal,
              ),
            setChallenge,
            (reason) => {
              if (!clearInaccessibleTest(reason))
                setError(
                  'We couldn’t check your message yet. Your code is unchanged. Try checking again.',
                );
            },
          ),
    [applyState, clearInaccessibleTest, run],
  );

  useEffect(() => {
    if (available && !challenge && !busy) input.current?.focus({ preventScroll: true });
  }, [available, busy, challenge]);

  const active = challenge?.status === 'creating' || challenge?.status === 'pending';
  useEffect(() => {
    if (!challenge || !active || busy || uncertain) return;
    const timer = setTimeout(() => void check(challenge), 5_000);
    return () => clearTimeout(timer);
  }, [active, busy, challenge, check, uncertain]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const secondsLeft = challenge
    ? Math.max(0, Math.ceil((new Date(challenge.expiresAt).getTime() - now) / 1_000))
    : 0;
  const localExpired = active && secondsLeft === 0;
  const pending = challenge?.status === 'pending';
  const verified = challenge?.status === 'verified';
  const terminal = challenge !== null && !active;
  const changing = busy === 'creating' || busy === 'canceling';
  const delivery = pending && !localExpired && !uncertain ? challenge.delivery : null;

  function create(event: FormEvent) {
    event.preventDefault();
    const normalized = attempt.current?.phone ?? normalizePhone(phone);
    if (!normalized) {
      setError('Enter a valid 10-digit US phone number. You can also paste it with +1.');
      input.current?.focus();
      return;
    }
    attempt.current ??= { phone: normalized, key: crypto.randomUUID() };
    const currentAttempt = attempt.current;
    void run(
      'creating',
      (signal) =>
        api<PhoneChallenge>(
          '/api/phone-verifications',
          { phone: currentAttempt.phone },
          currentAttempt.key,
          signal,
        ),
      (result) => {
        setChallenge(result);
        setUncertain(null);
        setPhone('');
      },
      (reason) => {
        if (clearInaccessibleTest(reason)) return;
        const ambiguous = !(
          reason instanceof RequestError &&
          reason.status >= 400 &&
          reason.status < 500 &&
          reason.status !== 408
        );
        setUncertain(ambiguous ? 'create' : null);
        if (!ambiguous) attempt.current = null;
        setError(
          ambiguous
            ? 'We couldn’t confirm that the code was created. Retry safely to retrieve this same test.'
            : errorMessage(reason),
        );
      },
    );
  }

  function cancel() {
    if (!challenge) return;
    void run(
      'canceling',
      (signal) =>
        api<PhoneChallenge>(
          `/api/phone-verifications/${challenge.id}/cancel`,
          {},
          undefined,
          signal,
        ),
      (result) => {
        setChallenge(result);
        setUncertain(null);
        attempt.current = null;
      },
      (reason) => {
        if (clearInaccessibleTest(reason)) return;
        setUncertain('cancel');
        setError(
          'We couldn’t confirm cancellation. Retry cancellation before starting another test.',
        );
      },
    );
  }

  function startAgain() {
    attempt.current = null;
    setChallenge(null);
    setUncertain(null);
    setError('');
    setCopied(false);
    setPhone('');
  }

  async function copyCode() {
    if (!delivery) return;
    try {
      await navigator.clipboard.writeText(delivery.code);
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current)
        setError('Select the code below to copy it, then paste it into Messages.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={verified ? 'Message received.' : 'A hello from your phone.'}
      description="Try Tallie’s connection to Messages."
      size="sm"
    >
      <div className="phone-test-badge">Development test</div>
      <div className="phone-verification-hero" aria-hidden="true">
        {verified ? <Check size={31} /> : <MessageCircle size={31} />}
      </div>

      {available === null ? (
        <>
          <p className="processing-note" role="status">
            {busy ? (
              <>
                <span className="ui-spinner" /> Checking your connection…
              </>
            ) : (
              'Your connection hasn’t loaded yet.'
            )}
          </p>
          {!busy && (
            <Button fullWidth variant="secondary" onClick={() => void resume()}>
              Try again
            </Button>
          )}
        </>
      ) : !available ? (
        <>
          <p className="form-hint">
            {sessionLost
              ? 'This session can no longer access that test. Close this view and reconnect to Tallie.'
              : 'Messages verification isn’t connected in this environment yet.'}
          </p>
          <Button fullWidth onClick={onClose}>
            Back to Tallie
          </Button>
        </>
      ) : !challenge ? (
        <form onSubmit={create}>
          <div className="form-field">
            <label htmlFor={inputId}>Your mobile number</label>
            <div className="phone-input">
              <span aria-hidden="true">+1</span>
              <input
                ref={input}
                id={inputId}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="Your 10-digit number"
                maxLength={24}
                value={phone}
                disabled={changing || uncertain === 'create'}
                aria-describedby={hintId}
                aria-label="US mobile number, country code plus one"
                onChange={(event) => {
                  setPhone(event.target.value);
                  setError('');
                }}
              />
            </div>
            <p id={hintId} className="fine-print">
              Use the number you’ll send the message from. US numbers only.
            </p>
          </div>
          <Button fullWidth size="lg" type="submit" loading={busy === 'creating'}>
            {uncertain === 'create' ? 'Retry safely' : 'Continue to Messages'}{' '}
            <ArrowUpRight size={18} />
          </Button>
          <p className="approval-note">
            You’ll get a code to send in Messages. Standard messaging rates may apply.
          </p>
        </form>
      ) : verified ? (
        <>
          <p className="processing-note" role="status">
            We confirmed a message from {challenge.maskedPhone}.
          </p>
          <Button fullWidth size="lg" onClick={onClose}>
            Lovely. <Check size={18} />
          </Button>
          <Button fullWidth variant="ghost" onClick={startAgain}>
            Try another number
          </Button>
        </>
      ) : terminal ? (
        <>
          <p className="form-hint" role="status">
            {challenge.status === 'expired'
              ? 'That code has expired. Start a fresh test when you’re ready.'
              : challenge.status === 'canceled'
                ? 'This test is canceled in Tallie. Its code can no longer complete this test.'
                : challenge.status === 'needs_retry'
                  ? 'We couldn’t securely match the provider’s result to this phone. No verification was granted.'
                  : 'We couldn’t prepare a usable code. No verification was granted.'}
          </p>
          <Button fullWidth onClick={startAgain}>
            Start a new test
          </Button>
        </>
      ) : (
        <>
          {delivery ? (
            <>
              <ol className="phone-instructions">
                <li>Open Messages and send the prepared code.</li>
                <li>
                  Send it from <strong>{challenge.maskedPhone}</strong>.
                </li>
                <li>Come back here. We’ll check for your message.</li>
              </ol>
              <div className="payment-summary">
                <div>
                  <span>Send to</span>
                  <strong>{delivery.number}</strong>
                </div>
                <div>
                  <span>Message</span>
                  <strong className="phone-code">{delivery.code}</strong>
                </div>
                <div>
                  <span>Code expires in</span>
                  <strong>
                    {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                  </strong>
                </div>
              </div>
              <div className="phone-actions">
                <a
                  className="ui-button ui-button--primary ui-button--lg ui-button--full"
                  href={delivery.smsDeepLink}
                >
                  Open Messages <ArrowUpRight size={18} />
                </a>
                <Button
                  fullWidth
                  variant="secondary"
                  onClick={() => void check(challenge)}
                  loading={busy === 'checking'}
                  disabled={changing}
                >
                  I’ve sent it
                </Button>
                <Button
                  fullWidth
                  variant="ghost"
                  icon={<Copy size={16} />}
                  onClick={() => void copyCode()}
                >
                  {copied ? 'Code copied' : 'Copy code instead'}
                </Button>
              </div>
              {copied && (
                <p className="approval-note" role="status">
                  Code copied. Send it to the number shown above.
                </p>
              )}
              <p className="approval-note">
                Opening Messages doesn’t send anything. Tap Send yourself, keeping the code
                unchanged.
              </p>
            </>
          ) : (
            <p className="processing-note" role="status">
              <span className="ui-spinner" />
              {uncertain === 'cancel'
                ? 'Cancellation needs confirmation.'
                : localExpired
                  ? 'Checking whether this code has expired…'
                  : 'Preparing your message…'}
            </p>
          )}
          <Button
            fullWidth
            variant="ghost"
            onClick={cancel}
            loading={busy === 'canceling'}
            disabled={busy !== null && busy !== 'canceling'}
          >
            {uncertain === 'cancel' ? 'Retry cancellation' : 'Cancel this test'}
          </Button>
          {!delivery && !uncertain && (
            <Button
              fullWidth
              variant="ghost"
              onClick={() => void check(challenge)}
              disabled={busy !== null}
            >
              Check again
            </Button>
          )}
        </>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="payment-assurance">
        <ShieldCheck size={16} />A phone-possession test only.
      </p>
      <p className="approval-note">
        This does not create an account, verify financial identity, enable payments, or subscribe
        you to messages.
      </p>
      {(active || changing || uncertain) && (
        <p className="approval-note">
          Closing this view won’t cancel a test already started. Reopen it here to check its status.
        </p>
      )}
    </Dialog>
  );
}
