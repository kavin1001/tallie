'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, RefreshCw, Wallet } from 'lucide-react';
import type { SandboxAccountState } from '@tallie/payments/contracts';
import { errorMessage, money, RequestError } from '@/lib/client';
import { AccountContext, useAccountApi } from '../account-context';
import { Avatar, Button } from '../ui';
import './share-payment.css';

type ShareStatus =
  | 'manual'
  | 'unpaid'
  | 'reviewing'
  | 'processing'
  | 'unknown'
  | 'paid'
  | 'returned'
  | 'failed'
  | 'canceled';
interface SharePaymentState {
  shareId: string;
  expenseId: string;
  amountMinor: string;
  status: ShareStatus;
  senderSetupRequired: boolean;
  recipientSetupRequired: boolean;
  sourceAvailableMinor: string | null;
  funding: { status: string; amountMinor: string; retryAllowed: boolean } | null;
  transfer: {
    id: string;
    reviewId: string;
    amountMinor: string;
    status: string;
    createdAt: string;
  } | null;
  canReview: boolean;
}
interface ShareReview {
  id: string;
  shareId: string;
  recipientName: string;
  phoneLast4: string | null;
  amountMinor: string;
  note: string;
  sourceAvailableMinor: string | null;
}
interface PendingApproval {
  reviewId: string;
  key: string;
}
const definitive = (cause: unknown) =>
  cause instanceof RequestError && cause.status >= 400 && cause.status < 500;

function readApproval(key: string): PendingApproval | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'reviewId' in value &&
      'key' in value &&
      typeof value.reviewId === 'string' &&
      typeof value.key === 'string'
    )
      return { reviewId: value.reviewId, key: value.key };
  } catch {
    /* The server's share lock still prevents duplicate payments without browser storage. */
  }
  return null;
}
function saveApproval(key: string, value: PendingApproval | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* Keep the exact approval in memory when browser storage is unavailable. */
  }
}

/** One fixed obligation. Neither the amount nor the destination can be edited here. */
export function SharePayment({
  shareId,
  payeeName,
  title,
  onChanged,
}: {
  shareId: string;
  payeeName: string;
  title: string;
  onChanged: () => Promise<void>;
}) {
  const api = useAccountApi();
  const accountId = useContext(AccountContext);
  const storageKey = `tallie:sandbox:share:${accountId}:${shareId}`;
  const endpoint = `/api/payments/sandbox/shares/${shareId}`;
  const [state, setState] = useState<SharePaymentState | null>(null);
  const [review, setReview] = useState<ShareReview | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState<string | null>('read');
  const [error, setError] = useState('');
  const [setupUncertain, setSetupUncertain] = useState(false);
  const [fundUncertain, setFundUncertain] = useState(false);
  const mounted = useRef(false);
  const reading = useRef(false);
  const mutation = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const reviewKey = useRef<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const approval = useRef<PendingApproval | null>(null);
  const currentState = useRef<SharePaymentState | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const publishChange = useCallback(() => {
    void changed.current().catch(() => undefined);
  }, []);
  const apply = useCallback(
    (next: SharePaymentState) => {
      const previous = currentState.current;
      currentState.current = next;
      setState(next);
      if (!next.senderSetupRequired) setSetupUncertain(false);
      if (next.funding) setFundUncertain(false);
      if (
        next.transfer &&
        (!approval.current || next.transfer.reviewId === approval.current.reviewId)
      ) {
        approval.current = null;
        setPending(null);
        saveApproval(storageKey, null);
        setReview(null);
        reviewKey.current = null;
      }
      if (previous && previous.status !== next.status) publishChange();
    },
    [publishChange, storageKey],
  );

  const read = useCallback(
    async (visible = false) => {
      if (reading.current || mutation.current) return;
      reading.current = true;
      const version = ++generation.current;
      const abort = new AbortController();
      controller.current = abort;
      if (visible) setBusy('read');
      try {
        const next = await api<SharePaymentState>(endpoint, undefined, undefined, abort.signal);
        if (!mounted.current || version !== generation.current) return;
        apply(next);
        setError('');
        if (visible) publishChange();
      } catch (cause) {
        if (mounted.current && version === generation.current && visible)
          setError(errorMessage(cause));
      } finally {
        if (version === generation.current) {
          reading.current = false;
          controller.current = null;
          if (mounted.current && visible) setBusy(null);
        }
      }
    },
    [api, apply, endpoint, publishChange],
  );

  useEffect(() => {
    mounted.current = true;
    approval.current = readApproval(storageKey);
    setPending(approval.current);
    void read(true);
    return () => {
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
      reading.current = false;
      mutation.current = false;
    };
  }, [read, storageKey]);
  useEffect(() => {
    if (
      !pending &&
      !setupUncertain &&
      !fundUncertain &&
      !['processing', 'unknown'].includes(state?.status ?? '')
    )
      return;
    const timer = window.setInterval(() => void read(), 5_000);
    return () => window.clearInterval(timer);
  }, [fundUncertain, pending, read, setupUncertain, state?.status]);

  async function run(action: 'setup' | 'fund' | 'review' | 'confirm') {
    if (mutation.current || !mounted.current) return;
    if (action === 'confirm' && !review && !approval.current) return;
    generation.current++;
    controller.current?.abort();
    reading.current = false;
    mutation.current = true;
    const version = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(action);
    setError('');
    let refresh = action !== 'review';
    try {
      if (action === 'setup' || action === 'fund') {
        const key = actionKeys.current.get(action) ?? crypto.randomUUID();
        actionKeys.current.set(action, key);
        await api(
          `/api/payments/sandbox/send/${action}`,
          action === 'setup'
            ? {}
            : { amountMinor: state?.funding?.amountMinor ?? initialDepositMinor },
          key,
          abort.signal,
        );
        if (!mounted.current || version !== generation.current) return;
        actionKeys.current.delete(action);
        setSetupUncertain(false);
        setFundUncertain(false);
      } else if (action === 'review') {
        reviewKey.current ??= crypto.randomUUID();
        const result = await api<{ review: ShareReview }>(
          `${endpoint}/review`,
          {},
          reviewKey.current,
          abort.signal,
        );
        if (!mounted.current || version !== generation.current) return;
        setReview(result.review);
      } else {
        const exact = approval.current ?? { reviewId: review!.id, key: crypto.randomUUID() };
        approval.current = exact;
        setPending(exact);
        saveApproval(storageKey, exact);
        await api(`${endpoint}/confirm`, { reviewId: exact.reviewId }, exact.key, abort.signal);
        if (!mounted.current || version !== generation.current) return;
        setReview(null);
      }
    } catch (cause) {
      if (!mounted.current || version !== generation.current) return;
      setError(
        action === 'confirm' && !definitive(cause)
          ? 'The reply didn’t reach us. We’re checking this same payment before doing anything else.'
          : errorMessage(cause),
      );
      if (action === 'review' && definitive(cause)) {
        reviewKey.current = null;
        refresh = true;
      }
      if (action === 'setup') setSetupUncertain(!definitive(cause));
      if (action === 'fund') setFundUncertain(!definitive(cause));
      if (action === 'confirm' && !definitive(cause)) setReview(null);
      if (action === 'confirm' && definitive(cause)) {
        approval.current = null;
        setPending(null);
        saveApproval(storageKey, null);
        setReview(null);
        reviewKey.current = null;
      }
    } finally {
      if (mounted.current && version === generation.current) {
        mutation.current = false;
        controller.current = null;
        setBusy(null);
        if (refresh) void read();
      }
    }
  }

  const locked = busy !== null;
  const balance = state?.sourceAvailableMinor ?? null;
  const covers = state && balance !== null && BigInt(balance) >= BigInt(state.amountMinor);
  const withinLimit = state !== null && BigInt(state.amountMinor) <= 10_000n;
  const initialDepositMinor =
    state && BigInt(state.amountMinor) > 2500n
      ? withinLimit
        ? state.amountMinor
        : '10000'
      : '2500';
  const unresolved =
    Boolean(pending) || state?.status === 'processing' || state?.status === 'unknown';
  const terminal = state && ['paid', 'returned', 'failed', 'canceled'].includes(state.status);
  const statusCopy =
    state?.status === 'paid'
      ? [
          'A little more all square.',
          `Your test share went to ${payeeName}. You’re both up to date.`,
        ]
      : state?.status === 'returned'
        ? [
            'This test payment came back.',
            state.canReview
              ? 'The test share is open again. Review a new test payment whenever you’re ready.'
              : 'The test share is open again. Check its status before trying another payment.',
          ]
        : state?.status === 'failed'
          ? [
              'This test payment didn’t complete.',
              state.canReview
                ? 'Your test share is still outstanding. You can review a new test payment.'
                : 'Your test share is still outstanding. We’ve kept the result here for review.',
            ]
          : state?.status === 'canceled'
            ? ['This request was canceled.', 'There’s nothing left to pay on this test share.']
            : [
                'A little patience, all square soon.',
                'We’re checking the saved payment. It counts as paid once Natural confirms it.',
              ];

  return (
    <section className="share-payment" aria-label="Your test repayment">
      <span className="account-test-badge">TEST MONEY ONLY</span>
      {!state ? (
        <div className="share-payment-message">
          <p role="status">
            {busy ? 'Finding your share…' : 'Let’s take another look at your test share.'}
          </p>
          {!busy && (
            <Button variant="secondary" onClick={() => void read(true)}>
              Check again
            </Button>
          )}
        </div>
      ) : (terminal || unresolved) && !review ? (
        <div
          className={`share-payment-result ${state.status === 'paid' ? 'paid' : ''}`}
          aria-live="polite"
        >
          <span className="share-payment-seal" aria-hidden="true">
            {state.status === 'paid' ? <Check size={25} /> : <RefreshCw size={22} />}
          </span>
          <h3>{statusCopy[0]}</h3>
          <strong className="share-payment-amount">{money(state.amountMinor)}</strong>
          <p>{statusCopy[1]}</p>
          {pending && !state.transfer && (
            <p className="share-payment-footnote">
              Your approval is saved in this tab. Retrying reuses that exact payment.
            </p>
          )}
          {state.canReview && (state.status === 'failed' || state.status === 'returned') && (
            <Button
              fullWidth
              loading={busy === 'review'}
              disabled={locked || !covers}
              onClick={() => void run('review')}
            >
              Review a new test payment <ArrowRight size={16} />
            </Button>
          )}
          {state.canReview && !covers && (
            <p className="share-payment-footnote">
              Check your test wallet balance before trying again.
            </p>
          )}
          <div className="share-payment-actions">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'read'}
              disabled={locked}
              onClick={() => void read(true)}
            >
              Check test payment
            </Button>
            {pending && !state.transfer && !locked && (
              <Button variant="ghost" size="sm" onClick={() => void run('confirm')}>
                Retry same approval
              </Button>
            )}
          </div>
        </div>
      ) : review ? (
        <div className="share-payment-review">
          <h3>One clear last look.</h3>
          <strong className="share-payment-amount">{money(review.amountMinor)}</strong>
          <div className="share-payment-person">
            <Avatar name={review.recipientName} size="sm" />
            <span>
              <strong>To {review.recipientName}</strong>
              {review.phoneLast4 && <small>Phone ending {review.phoneLast4}</small>}
            </span>
          </div>
          <dl>
            <div>
              <dt>For</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>
                Test wallet ·{' '}
                {review.sourceAvailableMinor === null
                  ? 'balance unavailable'
                  : money(review.sourceAvailableMinor)}
              </dd>
            </div>
          </dl>
          <p className="share-payment-footnote">
            This covers your exact share in this test split. No real money moves.
          </p>
          <Button
            fullWidth
            loading={busy === 'confirm'}
            disabled={locked}
            onClick={() => void run('confirm')}
          >
            Pay {money(review.amountMinor)} in test money <ArrowUpRight size={16} />
          </Button>
          <Button
            fullWidth
            variant="ghost"
            disabled={locked}
            onClick={() => {
              setReview(null);
              reviewKey.current = null;
              setError('');
            }}
          >
            Back to your share
          </Button>
        </div>
      ) : (
        <div className="share-payment-ready">
          <h3>Your little piece of the moment.</h3>
          <strong className="share-payment-amount">{money(state.amountMinor)}</strong>
          <p>
            To {payeeName} for {title}.
          </p>
          {state.recipientSetupRequired ? (
            <div className="share-payment-message">
              <p>{payeeName} needs to activate test receiving. Your share stays right here.</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={locked}
                onClick={() => void read(true)}
              >
                Check their setup
              </Button>
            </div>
          ) : state.senderSetupRequired ? (
            <div className="share-payment-message">
              <p>A quick test account setup, then back to this share.</p>
              <Button
                fullWidth
                loading={busy === 'setup'}
                disabled={locked}
                onClick={() => void run('setup')}
              >
                {setupUncertain ? 'Continue saved test setup' : 'Set up test sending'}{' '}
                <ArrowRight size={16} />
              </Button>
              {setupUncertain && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void read(true)}
                  disabled={locked}
                >
                  Check saved setup
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="share-payment-source">
                <Wallet size={17} />
                <span>Available test dollars</span>
                <strong>{balance === null ? 'Unavailable' : money(balance)}</strong>
              </div>
              {!covers && (
                <p className="share-payment-footnote">
                  {!withinLimit
                    ? 'Each test payment can be up to $100. Create a smaller test split to try settling up.'
                    : balance === null
                      ? 'We need a fresh balance before you can pay.'
                      : state.funding && !state.funding.retryAllowed && !fundUncertain
                        ? `Your saved test deposit is ${state.funding.status.toLowerCase()}. Check the balance, or try a smaller test split within the ${money(balance)} available.`
                        : 'Your test wallet needs a little more to cover this share.'}
                </p>
              )}
              {(!state.funding || state.funding.retryAllowed) && !covers && withinLimit && (
                <Button
                  fullWidth
                  variant="secondary"
                  loading={busy === 'fund'}
                  disabled={locked}
                  onClick={() => void run('fund')}
                >
                  {state.funding || fundUncertain
                    ? 'Retry saved test deposit'
                    : `Add ${money(initialDepositMinor)} test dollars`}
                </Button>
              )}
              {fundUncertain && (
                <p className="share-payment-footnote">
                  Checking the saved deposit. Retrying reuses this same deposit.
                </p>
              )}
              {!state.canReview && covers && (
                <p className="share-payment-footnote">
                  We couldn’t verify the test accounts. Check again, or ask {payeeName} to check
                  their test setup.
                </p>
              )}
              <Button
                fullWidth
                loading={busy === 'review'}
                disabled={locked || !state.canReview || !covers || fundUncertain}
                onClick={() => void run('review')}
              >
                Review test payment <ArrowRight size={16} />
              </Button>
              <Button
                fullWidth
                variant="ghost"
                loading={busy === 'read'}
                disabled={locked}
                onClick={() => void read(true)}
              >
                Check balance & payment
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="share-payment-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Receiver activation stays beside the split, so the payer does not lose their place. */
export function ShareReceivingSetup() {
  const api = useAccountApi();
  const [state, setState] = useState<SandboxAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const run = useCallback(
    async (action: 'read' | 'start' | 'retry' | 'refresh') => {
      if (active.current) return;
      active.current = true;
      const version = ++sequence.current;
      abort.current = new AbortController();
      setBusy(true);
      setError('');
      try {
        const next = await api<SandboxAccountState>(
          action === 'read' ? '/api/payments/sandbox' : `/api/payments/sandbox/${action}`,
          action === 'read' ? undefined : {},
          undefined,
          abort.current.signal,
        );
        if (mounted.current && version === sequence.current) setState(next);
      } catch (cause) {
        if (mounted.current && version === sequence.current) setError(errorMessage(cause));
      } finally {
        if (mounted.current && version === sequence.current) {
          active.current = false;
          setBusy(false);
        }
      }
    },
    [api],
  );
  useEffect(() => {
    mounted.current = true;
    void run('read');
    return () => {
      mounted.current = false;
      sequence.current++;
      abort.current?.abort();
      active.current = false;
    };
  }, [run]);
  if (state?.connection?.status === 'connected') return null;
  const retry = state?.connection?.retryAllowed;
  return (
    <section className="share-receiving-setup" aria-label="Test receiving setup">
      <Wallet size={19} />
      <div>
        <strong>Make room for your friends’ test shares.</strong>
        <p>
          Create your test receiving account to let friends settle this split with test dollars.
        </p>
        {error && <p role="alert">{error}</p>}
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={busy}
          onClick={() =>
            void run(!state ? 'read' : !state.connection ? 'start' : retry ? 'retry' : 'refresh')
          }
        >
          {!state
            ? 'Check test receiving'
            : !state.connection
              ? 'Activate test receiving'
              : retry
                ? 'Continue saved setup'
                : 'Check saved setup'}
        </Button>
      </div>
    </section>
  );
}
