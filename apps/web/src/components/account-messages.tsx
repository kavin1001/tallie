'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Fingerprint, MessageCircle, Receipt, ShieldCheck } from 'lucide-react';
import type { MessageDraft, MessagesState } from '@tallie/messaging/contracts';
import type { SignupChallenge } from '@tallie/identity/contracts';
import { identityClient } from '@tallie/identity/client';
import { errorMessage, money, RequestError } from '@/lib/client';
import { AccountContext, useAccountApi } from './account-context';
import { Button, Dialog } from './ui';

interface State extends MessagesState {
  number: string | null;
}

export function AccountMessages({
  onClose,
  onDraft,
  onExpense,
  selectedDraftId,
}: {
  onClose: () => void;
  onDraft: (draft: MessageDraft) => void;
  onExpense: (id: string) => void;
  selectedDraftId?: string;
}) {
  const api = useAccountApi();
  const accountId = useContext(AccountContext)!;
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<MessageDraft | null>(null);
  const [consent, setConsent] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [challenge, setChallenge] = useState<SignupChallenge | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [poll, setPoll] = useState(0);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const active = useRef(true);
  const proofKey = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<State>('/api/messages');
    if (active.current) setState(next);
  }, [api]);
  useEffect(() => {
    active.current = true;
    void refresh().catch((e) => {
      if (active.current) setError(errorMessage(e));
    });
    return () => {
      active.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!selectedDraftId) return;
    const abort = new AbortController();
    void api<MessageDraft>(
      `/api/messages/drafts/${selectedDraftId}`,
      undefined,
      undefined,
      abort.signal,
    )
      .then((draft) => {
        if (!abort.signal.aborted) setSelected(draft);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [api, selectedDraftId]);
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
        if (!abort.signal.aborted) {
          setChallenge(next);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!abort.signal.aborted) setPoll((value) => value + 1);
      }
    }, 4000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [api, pending, challenge, busy, poll]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (!active.current) return;
      if (e instanceof RequestError && e.code === 'STEP_UP_REQUIRED') setStepUp(true);
      else if (
        e instanceof RequestError &&
        ['FRESH_PHONE_PROOF_REQUIRED', 'WRONG_PROOF_PURPOSE'].includes(e.code)
      ) {
        setChallenge(null);
        proofKey.current = null;
        setNeedsPhone(true);
      } else setError(errorMessage(e));
    } finally {
      if (active.current) setBusy(false);
      lock.current = false;
    }
  }
  async function connect() {
    if (!consent) return;
    const next = await api<State>('/api/messages/connect', { consent: true, notifications });
    if (active.current) {
      setState(next);
      setChallenge(null);
      setNeedsPhone(false);
      setStepUp(false);
    }
  }
  async function startProof() {
    proofKey.current ??= crypto.randomUUID();
    try {
      const next = await api<SignupChallenge>('/api/identity/channel/start', {}, proofKey.current);
      if (active.current) {
        setChallenge(next);
        proofKey.current = null;
      }
    } catch (e) {
      if (e instanceof RequestError && e.status < 500) proofKey.current = null;
      throw e;
    }
  }
  const visibleDrafts = selected
    ? [selected, ...(state?.drafts ?? []).filter((draft) => draft.id !== selected.id)]
    : (state?.drafts ?? []);
  const seconds = challenge
    ? Math.max(0, Math.ceil((new Date(challenge.expiresAt).getTime() - now) / 1000))
    : 0;

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="A friend in your Messages."
      description="Send a receipt. Name your people. Let Tallie handle the little details."
    >
      <div className="messages-preview" aria-hidden="true">
        <span className="messages-preview-photo">
          <Receipt size={23} />
          <i>Dinner, with Maya & Leo</i>
        </span>
        <span>Good company. How would you like to split it?</span>
        <span>Equally, please ✨</span>
      </div>
      {!state ? (
        <p role="status">
          {error ? 'Messages couldn’t be loaded.' : 'Getting your conversation ready…'}
        </p>
      ) : !state.available ? (
        <p className="form-hint">
          Messages is being connected. Your account and web splits are ready to use.
        </p>
      ) : (
        <>
          {!state.sendingEnabled && (
            <p className="messages-setup-note">
              <ShieldCheck size={17} />
              Live conversations will open after Tallie’s public address and messaging line are
              connected.
            </p>
          )}
          {state.grant ? (
            <>
              <div className="account-security-row">
                <MessageCircle size={24} />
                <div>
                  <strong>
                    {state.grant.stopped
                      ? 'Your conversation is paused.'
                      : 'Your number is connected.'}
                  </strong>
                  <p>
                    {state.grant.maskedPhone} ·{' '}
                    {state.grant.notifications
                      ? 'Request notifications on'
                      : 'Request notifications off'}
                  </p>
                </div>
                <Check size={18} />
              </div>
              {state.sendingEnabled && state.number && (
                <a
                  className="ui-button ui-button--primary ui-button--lg ui-button--full"
                  href={`sms:${state.number}?body=${encodeURIComponent(state.grant.stopped ? 'START' : 'Hi Tallie')}`}
                >
                  Open Messages <ArrowRight size={17} />
                </a>
              )}
              <p className="fine-print">
                Reply STOP to pause. Signing out ends this connection. Reconnect here when you’re
                ready.
              </p>
              <Button
                variant="ghost"
                fullWidth
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/api/messages/disconnect', {});
                    await refresh();
                  })
                }
              >
                Disconnect Messages
              </Button>
            </>
          ) : (
            <>
              <label className="messages-choice">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Let Tallie read my messages to its number and reply with receipt drafts and split
                  details.
                </span>
              </label>
              <label className="messages-choice">
                <input
                  type="checkbox"
                  checked={notifications}
                  disabled={busy}
                  onChange={(e) => setNotifications(e.target.checked)}
                />
                <span>
                  Tell me when a friend sends a request.
                  <small>Optional. You can disconnect or reply STOP at any time.</small>
                </span>
              </label>
              <p className="fine-print">
                Messages never authorizes a debit. Standard messaging rates may apply.
              </p>
              {stepUp ? (
                <Button
                  fullWidth
                  loading={busy}
                  disabled={!consent}
                  onClick={() =>
                    void run(async () => {
                      const result = await identityClient.signIn.passkey({
                        fetchOptions: { headers: { 'X-Tallie-Account': accountId } },
                      });
                      if (result.error)
                        throw new Error('Use the passkey for this Tallie account, then try again.');
                      if (active.current) {
                        setChallenge(null);
                        proofKey.current = null;
                        setStepUp(false);
                        setNeedsPhone(true);
                      }
                    })
                  }
                >
                  Confirm it’s you <Fingerprint size={17} />
                </Button>
              ) : needsPhone ? (
                <>
                  {challenge?.status === 'verified' ? (
                    <Button
                      fullWidth
                      loading={busy}
                      disabled={!consent}
                      onClick={() =>
                        void run(async () => {
                          await api('/api/identity/channel/complete', {
                            challengeId: challenge.id,
                          });
                          await connect();
                        })
                      }
                    >
                      Finish connecting <ArrowRight size={17} />
                    </Button>
                  ) : pending ? (
                    <>
                      {challenge.delivery && seconds > 0 ? (
                        <>
                          <div className="account-verification-slip">
                            <span>SEND FROM {challenge.maskedPhone}</span>
                            <strong className="phone-code">{challenge.delivery.code}</strong>
                            <p>To {challenge.delivery.number}</p>
                            <small>
                              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}{' '}
                              remaining
                            </small>
                          </div>
                          <a
                            href={challenge.delivery.smsDeepLink}
                            className="ui-button ui-button--primary ui-button--lg ui-button--full"
                          >
                            Open Messages <ArrowRight size={17} />
                          </a>
                        </>
                      ) : (
                        <p role="status">Checking your verification…</p>
                      )}
                      <Button
                        variant="ghost"
                        fullWidth
                        loading={busy}
                        onClick={() =>
                          void run(async () => {
                            const next = await api<SignupChallenge>('/api/identity/signup/check', {
                              challengeId: challenge.id,
                            });
                            if (active.current) setChallenge(next);
                          })
                        }
                      >
                        I’ve sent it
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="form-hint">
                        Confirm that you still have your number before connecting it to your
                        account.
                      </p>
                      <Button
                        fullWidth
                        loading={busy}
                        disabled={!consent}
                        onClick={() => void run(startProof)}
                      >
                        Verify my number <MessageCircle size={17} />
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <Button
                  fullWidth
                  size="lg"
                  disabled={!consent}
                  loading={busy}
                  onClick={() => void run(connect)}
                >
                  Connect my Messages <ArrowRight size={17} />
                </Button>
              )}
            </>
          )}
        </>
      )}
      {visibleDrafts.length > 0 && (
        <section className="messages-drafts">
          <h3>From your conversation</h3>
          {visibleDrafts.map((draft) => (
            <button
              key={draft.id}
              disabled={busy}
              onClick={() => {
                if (draft.expenseId) onExpense(draft.expenseId);
                else if (draft.publicationPending)
                  void run(async () => {
                    const result = await api<{ expenseId: string }>(
                      `/api/messages/drafts/${draft.id}/publish/resume`,
                      {},
                    );
                    if (active.current) onExpense(result.expenseId);
                  });
                else onDraft(draft);
              }}
            >
              <span className="messages-draft-icon">
                <Receipt size={18} />
              </span>
              <span>
                <strong>{draft.publicationInput?.title ?? draft.title ?? 'Your receipt'}</strong>
                <small>
                  {draft.expenseId
                    ? 'Split saved'
                    : draft.publicationPending
                      ? 'Finish saving your approved split'
                      : draft.receiptStatus === 'processing'
                        ? 'Reading your receipt'
                        : 'Ready to review'}
                  {(draft.publicationInput?.totalMinor ?? draft.totalMinor)
                    ? ` · ${money(draft.publicationInput?.totalMinor ?? draft.totalMinor!)}`
                    : ''}
                </small>
              </span>
              <ArrowRight size={17} />
            </button>
          ))}
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!state && error && <Button onClick={() => void run(refresh)}>Try again</Button>}
    </Dialog>
  );
}
