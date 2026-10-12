'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, RefreshCw, Send, Sparkles, Wallet } from 'lucide-react';
import { cents, errorMessage, money, RequestError } from '@/lib/client';
import { AccountContext, useAccountApi } from '../account-context';
import { Flower } from '../brand';
import { Avatar, Button, Dialog } from '../ui';
import './sandbox-send.css';

type ConnectionStatus = 'not_started' | 'setting_up' | 'ready' | 'unknown' | 'blocked';

interface SandboxSendState {
  available: boolean;
  connection: {
    status: ConnectionStatus;
    retryAllowed: boolean;
    balances: { id: string; currency: 'USD'; availableMinor: string | null }[];
  } | null;
  recipients: { accountId: string; name: string; phoneLast4: string | null }[];
  transfers: SandboxTransfer[];
  funding?: { status: string; amountMinor: string; retryAllowed: boolean } | null;
}

interface SandboxSendReview {
  id: string;
  recipientName: string;
  phoneLast4: string | null;
  amountMinor: string;
  note: string;
  sourceWalletId: string;
  sourceAvailableMinor: string | null;
}

interface SandboxTransfer {
  id: string;
  reviewId?: string;
  recipientName: string;
  amountMinor: string;
  status: string;
  createdAt: string;
}

type Busy = 'read' | 'setup' | 'fund' | 'review' | 'confirm' | null;
type Screen = 'compose' | 'review' | 'result' | 'unknown';

const testRecipientId = 'sandbox-fixture';

function transferCopy(status: string): { label: string; detail: string; final: boolean } {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'settled':
    case 'succeeded':
      return { label: 'Complete', detail: 'Natural confirmed this test transfer.', final: true };
    case 'failed':
    case 'returned':
    case 'canceled':
    case 'cancelled':
    case 'approval_denied':
    case 'rejected':
      return {
        label: 'Didn’t complete',
        detail: 'This test transfer did not complete.',
        final: true,
      };
    case 'held':
      return {
        label: 'Needs a closer look',
        detail: 'Natural is holding this test transfer.',
        final: false,
      };
    default:
      return {
        label: 'Checking the transfer',
        detail: 'We’ll call it complete only after Natural confirms it.',
        final: false,
      };
  }
}

function availableBalance(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    const balance = BigInt(value);
    return balance >= 0n ? balance : null;
  } catch {
    return null;
  }
}

function safeBalance(value: string | null): string {
  const balance = availableBalance(value);
  return balance === null ? 'Balance unavailable' : money(balance.toString());
}

function fundingCopy(funding: NonNullable<SandboxSendState['funding']>): string {
  switch (funding.status.toLowerCase()) {
    case 'completed':
      return 'confirmed';
    case 'failed':
      return funding.retryAllowed ? 'didn’t go through; you can retry' : 'did not complete';
    case 'returned':
      return 'returned';
    case 'unknown':
      return 'checking the result; don’t add another deposit';
    case 'created':
    case 'processing':
      return 'processing';
    default:
      return 'needs a closer look';
  }
}

function canCoverReview(review: SandboxSendReview): boolean {
  if (review.sourceAvailableMinor === null) return false;
  try {
    return BigInt(review.sourceAvailableMinor) >= BigInt(review.amountMinor);
  } catch {
    return false;
  }
}

function isDefinitive(error: unknown): boolean {
  return error instanceof RequestError && error.status >= 400 && error.status < 500;
}

function readPendingReview(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePendingReview(key: string, reviewId: string): void {
  try {
    window.sessionStorage.setItem(key, reviewId);
  } catch {
    // The in-memory recovery marker still protects this tab.
  }
}

function clearPendingReview(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled without changing the transfer's server state.
  }
}

/** A deliberately separate sandbox send surface. Ordinary splits remain unpaid. */
export function SandboxSend() {
  const api = useAccountApi();
  const accountId = useContext(AccountContext);
  const recoveryStorageKey = accountId ? `tallie:sandbox:send:${accountId}` : null;
  const [state, setState] = useState<SandboxSendState | null>(null);
  const [busy, setBusy] = useState<Busy>('read');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>('compose');
  const [recipientId, setRecipientId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [review, setReview] = useState<SandboxSendReview | null>(null);
  const [transfer, setTransfer] = useState<SandboxTransfer | null>(null);
  const [reviewUncertain, setReviewUncertain] = useState(false);
  const [setupUncertain, setSetupUncertain] = useState(false);
  const [fundUncertain, setFundUncertain] = useState(false);
  const mounted = useRef(false);
  const reading = useRef(false);
  const mutating = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const mutationSequence = useRef(0);
  const mutationController = useRef<AbortController | null>(null);
  const reviewAttempt = useRef<{
    key: string;
    body: { recipientAccountId: string; amountMinor: string; note: string };
  } | null>(null);
  const confirmAttempt = useRef<{ key: string; reviewId: string } | null>(null);
  const setupKey = useRef<string | null>(null);
  const fundKey = useRef<string | null>(null);
  const reviewIdForRecovery = useRef<string | null>(null);

  const readState = useCallback(
    async (showProgress = false) => {
      if (reading.current || mutating.current) return;
      reading.current = true;
      const version = ++readSequence.current;
      const controller = new AbortController();
      readController.current = controller;
      if (showProgress) setBusy('read');
      try {
        const next = await api<SandboxSendState>(
          '/api/payments/sandbox/send',
          undefined,
          undefined,
          controller.signal,
        );
        if (!mounted.current || version !== readSequence.current) return;
        setState(next);
        setTransfer((current) =>
          current ? (next.transfers.find((item) => item.id === current.id) ?? current) : current,
        );
        if (reviewIdForRecovery.current) {
          const exact = next.transfers.find(
            (item) => item.reviewId === reviewIdForRecovery.current,
          );
          if (exact) {
            setTransfer(exact);
            setScreen('result');
            reviewIdForRecovery.current = null;
            if (recoveryStorageKey) clearPendingReview(recoveryStorageKey);
          }
        }
        setError('');
        if (next.connection?.status !== 'not_started') setSetupUncertain(false);
        if (next.funding) setFundUncertain(false);
      } catch (cause) {
        if (mounted.current && version === readSequence.current && showProgress)
          setError(errorMessage(cause));
      } finally {
        if (version === readSequence.current) {
          reading.current = false;
          readController.current = null;
          if (mounted.current && showProgress) setBusy(null);
        }
      }
    },
    [api, recoveryStorageKey],
  );

  useEffect(() => {
    mounted.current = true;
    if (recoveryStorageKey) {
      const savedReviewId = readPendingReview(recoveryStorageKey);
      if (savedReviewId) {
        reviewIdForRecovery.current = savedReviewId;
        setScreen('unknown');
        setOpen(true);
      }
    }
    void readState(true);
    return () => {
      mounted.current = false;
      readSequence.current++;
      readController.current?.abort();
      readController.current = null;
      reading.current = false;
      mutationSequence.current++;
      mutationController.current?.abort();
      mutationController.current = null;
      mutating.current = false;
    };
  }, [readState, recoveryStorageKey]);

  useEffect(() => {
    const shouldPoll =
      state?.connection?.status === 'setting_up' ||
      setupUncertain ||
      fundUncertain ||
      (state?.funding !== null &&
        state?.funding !== undefined &&
        !['completed', 'failed', 'returned'].includes(state.funding.status.toLowerCase())) ||
      screen === 'unknown' ||
      (screen === 'result' && transfer !== null && !transferCopy(transfer.status).final);
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void readState(), 5_000);
    return () => window.clearInterval(timer);
  }, [
    fundUncertain,
    readState,
    screen,
    setupUncertain,
    state?.connection?.status,
    state?.funding,
    transfer,
  ]);

  function cancelStaleRead() {
    readSequence.current++;
    readController.current?.abort();
    readController.current = null;
    reading.current = false;
  }

  async function changeConnection(action: 'setup' | 'fund', fundAmountMinor = '2500') {
    if (mutating.current) return;
    cancelStaleRead();
    mutating.current = true;
    const version = ++mutationSequence.current;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(action);
    setError('');
    if (action === 'setup') setupKey.current ??= crypto.randomUUID();
    if (action === 'fund') fundKey.current ??= crypto.randomUUID();
    try {
      const next = await api<SandboxSendState>(
        `/api/payments/sandbox/send/${action}`,
        action === 'setup' ? {} : { amountMinor: fundAmountMinor },
        action === 'setup' ? (setupKey.current ?? undefined) : (fundKey.current ?? undefined),
        controller.signal,
      );
      if (!mounted.current || version !== mutationSequence.current) return;
      setState(next);
      setSetupUncertain(false);
      setFundUncertain(false);
      if (action === 'setup') setupKey.current = null;
      if (action === 'fund') fundKey.current = null;
    } catch (cause) {
      if (!mounted.current || version !== mutationSequence.current) return;
      setError(errorMessage(cause));
      if (action === 'setup') {
        setSetupUncertain(!isDefinitive(cause));
        if (isDefinitive(cause)) setupKey.current = null;
      }
      if (action === 'fund') {
        setFundUncertain(!isDefinitive(cause));
        if (isDefinitive(cause)) fundKey.current = null;
      }
    } finally {
      if (version === mutationSequence.current) {
        mutating.current = false;
        mutationController.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  }

  function beginSend() {
    setError('');
    setReview(null);
    setTransfer(null);
    setScreen('compose');
    setRecipientId('');
    setAmount('');
    setNote('');
    setReviewUncertain(false);
    reviewAttempt.current = null;
    confirmAttempt.current = null;
    reviewIdForRecovery.current = null;
    setOpen(true);
  }

  function updateDraft(change: () => void) {
    change();
    setReviewUncertain(false);
    reviewAttempt.current = null;
    setError('');
  }

  async function prepareReview() {
    if (mutating.current) return;
    setError('');
    if (!state?.available || state.connection?.status !== 'ready') {
      setError('Your test sending account needs a fresh check before continuing.');
      return;
    }
    if (!hasSpendableBalance) {
      setError(balanceHelp);
      return;
    }
    if (!state?.recipients.some((person) => person.accountId === recipientId)) {
      setError('Choose a test recipient.');
      return;
    }
    let amountMinor: string;
    try {
      amountMinor = cents(amount);
      if (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > 10_000n)
        throw new Error('Enter an amount from $0.01 to $100.00.');
    } catch {
      setError('Enter an amount from $0.01 to $100.00 with at most two decimal places.');
      return;
    }
    const body = { recipientAccountId: recipientId, amountMinor, note: note.trim() };
    if (
      !reviewAttempt.current ||
      JSON.stringify(reviewAttempt.current.body) !== JSON.stringify(body)
    ) {
      reviewAttempt.current = { key: crypto.randomUUID(), body };
    }
    cancelStaleRead();
    mutating.current = true;
    const version = ++mutationSequence.current;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy('review');
    try {
      const next = await api<{ review: SandboxSendReview }>(
        '/api/payments/sandbox/send/review',
        body,
        reviewAttempt.current.key,
        controller.signal,
      );
      if (!mounted.current || version !== mutationSequence.current) return;
      setReview(next.review);
      setReviewUncertain(false);
      setScreen('review');
    } catch (cause) {
      if (!mounted.current || version !== mutationSequence.current) return;
      setError(errorMessage(cause));
      setReviewUncertain(!isDefinitive(cause));
      if (isDefinitive(cause)) reviewAttempt.current = null;
    } finally {
      if (version === mutationSequence.current) {
        mutating.current = false;
        mutationController.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  }

  async function confirmSend() {
    if (mutating.current || !review) return;
    if (!state?.available || state.connection?.status !== 'ready') {
      setError('Your test sending account needs a fresh check before continuing.');
      return;
    }
    if (!confirmAttempt.current || confirmAttempt.current.reviewId !== review.id) {
      confirmAttempt.current = { key: crypto.randomUUID(), reviewId: review.id };
    }
    cancelStaleRead();
    mutating.current = true;
    const version = ++mutationSequence.current;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy('confirm');
    setError('');
    if (recoveryStorageKey) savePendingReview(recoveryStorageKey, review.id);
    try {
      const next = await api<{ transfer: SandboxTransfer }>(
        '/api/payments/sandbox/send/confirm',
        { reviewId: review.id },
        confirmAttempt.current.key,
        controller.signal,
      );
      if (!mounted.current || version !== mutationSequence.current) return;
      setTransfer(next.transfer);
      setScreen('result');
      reviewIdForRecovery.current = null;
      if (recoveryStorageKey) clearPendingReview(recoveryStorageKey);
    } catch (cause) {
      if (!mounted.current || version !== mutationSequence.current) return;
      setError(
        isDefinitive(cause)
          ? errorMessage(cause)
          : 'We lost the reply. The test transfer may have started; check its result before doing anything else.',
      );
      if (!isDefinitive(cause)) {
        reviewIdForRecovery.current = review.id;
        setScreen('unknown');
      } else if (recoveryStorageKey) {
        clearPendingReview(recoveryStorageKey);
      }
    } finally {
      if (version === mutationSequence.current) {
        mutating.current = false;
        mutationController.current = null;
      }
      if (mounted.current && version === mutationSequence.current) {
        setBusy(null);
        void readState();
      }
    }
  }

  const connection = state?.connection;
  const ready = connection?.status === 'ready';
  const balances = connection?.balances.map((wallet) => availableBalance(wallet.availableMinor));
  const hasSpendableBalance =
    balances?.some((balance) => balance !== null && balance > 0n) ?? false;
  const balanceUnavailable = !balances?.length || balances.some((balance) => balance === null);
  const balanceHelp = balanceUnavailable
    ? 'Your test balance is unavailable. Check it again before sending.'
    : !state?.funding
      ? 'Add test dollars before sending your first test payment.'
      : state.funding.retryAllowed
        ? 'Retry the saved test deposit to fund your test wallet.'
        : 'There are no test dollars available to send. Check your balance to get the latest amount.';
  const selectedRecipient = state?.recipients.find((person) => person.accountId === recipientId);
  const sourceBalance = review ? safeBalance(review.sourceAvailableMinor) : null;
  const completed = transfer ? transferCopy(transfer.status).label === 'Complete' : false;
  const resultCopy = transfer ? transferCopy(transfer.status) : null;
  const unresolved =
    screen === 'unknown' ||
    (transfer !== null && !transferCopy(transfer.status).final) ||
    Boolean(state?.transfers.some((item) => !transferCopy(item.status).final));

  return (
    <section className="sandbox-send" aria-label="Send test payments">
      <div className="sandbox-send-heading">
        <div>
          <span className="sandbox-send-eyebrow">A SMALL STEP FOR THE SANDBOX</span>
          <h3>
            Send a little test money<span aria-hidden="true">✳</span>
          </h3>
          <p>Try the full send flow with sandbox dollars. Nothing here moves real money.</p>
        </div>
        <div className="sandbox-send-stamp" aria-hidden="true">
          <Send size={19} />
        </div>
      </div>

      {busy === 'read' && !state ? (
        <p className="sandbox-send-muted" role="status">
          Checking your test sending setup…
        </p>
      ) : !state ? (
        <div className="sandbox-send-message">
          <p>We couldn’t check test sending just yet.</p>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void readState(true)}
            disabled={busy !== null}
          >
            Check again
          </Button>
        </div>
      ) : !state.available ? (
        <p className="sandbox-send-muted">Test sending isn’t available for this account yet.</p>
      ) : connection?.status === 'blocked' ? (
        <div className="sandbox-send-message">
          <strong>Setup needs a closer look.</strong>
          <p>We can’t confirm your test sending permission. Check again in a moment.</p>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void readState(true)}
            disabled={busy !== null}
          >
            Check setup
          </Button>
        </div>
      ) : connection?.status === 'unknown' ||
        connection?.status === 'setting_up' ||
        setupUncertain ? (
        <div className="sandbox-send-message">
          <strong>
            {connection?.status === 'setting_up'
              ? 'Setting up your test sending account.'
              : 'We’re checking where setup landed.'}
          </strong>
          <p>We’ll wait for a confirmed result before offering a transfer.</p>
          {connection?.retryAllowed && (
            <Button
              size="sm"
              loading={busy === 'setup'}
              disabled={busy !== null}
              onClick={() => void changeConnection('setup')}
            >
              Continue setup <ArrowRight size={15} />
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void readState(true)}
            disabled={busy !== null}
          >
            Check setup
          </Button>
        </div>
      ) : ready && state ? (
        <>
          <div className="sandbox-send-ready">
            <div className="sandbox-send-balance">
              <Wallet size={18} aria-hidden="true" />
              <div>
                <span>Available for test sends</span>
                <strong>
                  {connection.balances.length === 1
                    ? safeBalance(connection.balances[0]?.availableMinor ?? null)
                    : `${connection.balances.length} test wallets`}
                </strong>
              </div>
            </div>
            <div className="sandbox-send-ready-actions">
              {(!state.funding || state.funding.retryAllowed) && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'fund'}
                  disabled={busy !== null || fundUncertain}
                  onClick={() =>
                    void changeConnection('fund', state.funding?.amountMinor ?? '2500')
                  }
                >
                  {state.funding ? 'Retry test deposit' : 'Add $25 test dollars'}
                </Button>
              )}
              <Button
                size="sm"
                icon={<ArrowUpRight size={15} />}
                disabled={
                  busy !== null ||
                  state.recipients.length === 0 ||
                  unresolved ||
                  !hasSpendableBalance
                }
                onClick={beginSend}
              >
                Send test money
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={14} />}
                loading={busy === 'read'}
                disabled={busy !== null}
                onClick={() => void readState(true)}
              >
                Check test balance
              </Button>
            </div>
          </div>
          {!hasSpendableBalance && <p className="sandbox-send-muted">{balanceHelp}</p>}
          {unresolved && (
            <p className="sandbox-send-caution">
              A test transfer is still being checked. Wait for its result before starting another.
            </p>
          )}
          {state.recipients.length === 0 && (
            <p className="sandbox-send-muted">
              A test receiving account will appear here when it’s ready.
            </p>
          )}
          {state.funding && (
            <p className="sandbox-send-muted">
              Test deposit: {safeBalance(state.funding.amountMinor)} · {fundingCopy(state.funding)}
            </p>
          )}
          {state.funding?.retryAllowed && (
            <p className="sandbox-send-muted">
              Retry uses the same saved test deposit. It won’t create a second one.
            </p>
          )}
          {fundUncertain && (
            <p className="sandbox-send-caution">
              We’re checking whether test funds were added. Check your balance before adding more.
            </p>
          )}
          {state.transfers.length > 0 && (
            <div className="sandbox-send-history">
              <div className="sandbox-send-history-heading">
                <span>Recent test sends</span>
                <button
                  type="button"
                  onClick={() => void readState(true)}
                  disabled={busy !== null}
                  aria-label="Refresh test transfers"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              {state.transfers.slice(0, 3).map((item) => (
                <div className="sandbox-send-history-row" key={item.id}>
                  <span className="sandbox-send-history-icon">
                    <ArrowUpRight size={17} />
                  </span>
                  <span>
                    <strong>{item.recipientName}</strong>
                    <small>{transferCopy(item.status).label}</small>
                  </span>
                  <b>{money(item.amountMinor)}</b>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="sandbox-send-message">
          <p>
            Your account is ready to explore. Add test sending permission when you want to try a
            transfer.
          </p>
          <Button
            size="sm"
            loading={busy === 'setup'}
            disabled={busy !== null}
            onClick={() => void changeConnection('setup')}
          >
            Set up test sending <ArrowRight size={15} />
          </Button>
        </div>
      )}
      {error && !open && (
        <p className="sandbox-send-error" role="alert">
          {error}
        </p>
      )}

      {open && (
        <Dialog
          open
          size="sm"
          className="sandbox-send-dialog"
          onClose={() => {
            if (busy !== 'confirm') setOpen(false);
          }}
          title={
            screen === 'compose'
              ? 'A little goes a long way.'
              : screen === 'review'
                ? 'One clear last look.'
                : screen === 'unknown'
                  ? 'Checking where it landed.'
                  : completed
                    ? 'Test money, sent.'
                    : 'Your test transfer.'
          }
          description="Natural sandbox · test dollars only"
        >
          {screen === 'compose' && (
            <div className="sandbox-send-compose">
              <div className="sandbox-send-field-label">Who gets the test money?</div>
              <div className="sandbox-send-recipient-list">
                {(state?.recipients ?? []).map((person) => {
                  const isTestAccount = person.accountId === testRecipientId;
                  return (
                    <label
                      className={`sandbox-send-recipient ${recipientId === person.accountId ? 'selected' : ''}`}
                      key={person.accountId}
                    >
                      <input
                        type="radio"
                        name="sandbox-recipient"
                        value={person.accountId}
                        checked={recipientId === person.accountId}
                        onChange={() => updateDraft(() => setRecipientId(person.accountId))}
                        disabled={busy !== null}
                      />
                      {isTestAccount ? (
                        <span className="sandbox-send-recipient-mark">
                          <Flower />
                        </span>
                      ) : (
                        <Avatar name={person.name} size="sm" />
                      )}
                      <span>
                        <strong>
                          {isTestAccount ? 'Your test receiving account' : person.name}
                        </strong>
                        <small>
                          {isTestAccount
                            ? 'Between your two sandbox test accounts'
                            : person.phoneLast4
                              ? `Tallie friend · phone ending ${person.phoneLast4}`
                              : 'Tallie friend with a test account'}
                        </small>
                      </span>
                      <span className="sandbox-send-radio-mark" aria-hidden="true" />
                    </label>
                  );
                })}
              </div>
              <label className="sandbox-send-amount-label">
                Amount in USD
                <span>
                  <b aria-hidden="true">$</b>
                  <input
                    value={amount}
                    onChange={(event) => updateDraft(() => setAmount(event.target.value))}
                    inputMode="decimal"
                    type="text"
                    autoComplete="off"
                    maxLength={18}
                    placeholder="0.00"
                    disabled={busy !== null}
                  />
                </span>
              </label>
              <label className="sandbox-send-note-label">
                A note, if you’d like
                <input
                  value={note}
                  onChange={(event) => updateDraft(() => setNote(event.target.value))}
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  placeholder="For the good stuff"
                  disabled={busy !== null}
                />
              </label>
              {selectedRecipient?.accountId === testRecipientId && (
                <p className="sandbox-send-help">
                  This goes to your second sandbox test account. No friend receives money.
                </p>
              )}
              {reviewUncertain && (
                <p className="sandbox-send-caution">
                  The review may have been saved. Retry the same details to check safely.
                </p>
              )}
              {!hasSpendableBalance && <p className="sandbox-send-caution">{balanceHelp}</p>}
              {error && (
                <p className="sandbox-send-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                fullWidth
                loading={busy === 'review'}
                disabled={busy !== null || !hasSpendableBalance}
                onClick={() => void prepareReview()}
              >
                Review test payment <ArrowRight size={16} />
              </Button>
            </div>
          )}
          {screen === 'review' && review && (
            <div className="sandbox-send-review">
              <div className="sandbox-send-review-hero">
                <span>TEST PAYMENT</span>
                <strong>{money(review.amountMinor)}</strong>
                <small>Nothing real moves here.</small>
              </div>
              <div className="sandbox-send-review-lines">
                <div>
                  <span>To</span>
                  <strong>
                    {review.recipientName}
                    {review.phoneLast4 ? ` · phone ending ${review.phoneLast4}` : ''}
                  </strong>
                </div>
                <div>
                  <span>From</span>
                  <strong>Test wallet · {sourceBalance}</strong>
                </div>
                {review.note && (
                  <div>
                    <span>For</span>
                    <strong>{review.note}</strong>
                  </div>
                )}
              </div>
              {selectedRecipient?.accountId === testRecipientId && (
                <p className="sandbox-send-help">
                  Between your two sandbox test accounts. No friend receives money.
                </p>
              )}
              {!canCoverReview(review) && (
                <p className="sandbox-send-caution">
                  This test wallet cannot cover the amount right now. Check its balance or choose a
                  smaller amount.
                </p>
              )}
              {error && (
                <p className="sandbox-send-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                fullWidth
                loading={busy === 'confirm'}
                disabled={busy !== null || !canCoverReview(review)}
                onClick={() => void confirmSend()}
              >
                Send {money(review.amountMinor)} test payment <ArrowUpRight size={16} />
              </Button>
              <Button
                fullWidth
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setScreen('compose');
                  setReview(null);
                  setReviewUncertain(false);
                  setError('');
                  reviewAttempt.current = null;
                  confirmAttempt.current = null;
                }}
              >
                Change details
              </Button>
            </div>
          )}
          {screen === 'unknown' && (
            <div className="sandbox-send-outcome">
              <span className="sandbox-send-outcome-icon">
                <RefreshCw size={25} />
              </span>
              <p>
                We haven’t confirmed whether your test payment started. We’re checking the saved
                record. Please don’t send it again.
              </p>
              {error && (
                <p className="sandbox-send-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                fullWidth
                variant="secondary"
                loading={busy === 'read'}
                disabled={busy !== null}
                onClick={() => void readState(true)}
              >
                Check test payment
              </Button>
            </div>
          )}
          {screen === 'result' && transfer && resultCopy && (
            <div className="sandbox-send-outcome">
              <span className={`sandbox-send-outcome-icon ${completed ? 'complete' : ''}`}>
                {completed ? <Check size={28} /> : <Sparkles size={26} />}
              </span>
              <strong className="sandbox-send-outcome-amount">{money(transfer.amountMinor)}</strong>
              <p>
                {completed
                  ? `Sent to ${transfer.recipientName} in the Natural sandbox.`
                  : resultCopy.detail}
              </p>
              <span className="sandbox-send-outcome-state">{resultCopy.label}</span>
              <Button
                fullWidth
                variant="secondary"
                icon={resultCopy.final ? <Check size={15} /> : <RefreshCw size={15} />}
                onClick={() => (resultCopy.final ? setOpen(false) : void readState(true))}
              >
                {' '}
                {resultCopy.final ? 'Done' : 'Check status'}
              </Button>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}
