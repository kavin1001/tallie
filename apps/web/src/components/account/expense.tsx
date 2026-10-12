'use client';
import { useAccountApi } from '../account-context';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, LockKeyhole, Receipt, RefreshCw, X } from 'lucide-react';
import type { SocialContact, SocialExpense, SocialShare } from '@tallie/social/contracts';
import { errorMessage, money, shortDate } from '@/lib/client';
import { Avatar, Button, Dialog } from '../ui';
import { SharePayment, ShareReceivingSetup } from './share-payment';

export function AccountExpense({
  id,
  contacts,
  onClose,
  onInvite,
  onUpdated,
}: {
  id: string;
  contacts: SocialContact[];
  onClose: () => void;
  onInvite: (contact: SocialContact, expenseId?: string) => void;
  onUpdated: () => Promise<void>;
}) {
  const api = useAccountApi();
  const [expense, setExpense] = useState<SocialExpense | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const generation = useRef(0);
  const cancelLock = useRef(false);
  const paymentCheckLock = useRef(false);
  const [checkingPayments, setCheckingPayments] = useState(false);
  const loadCurrent = useRef<() => Promise<void>>(async () => undefined);
  async function load(showProgress = true) {
    const current = ++generation.current;
    if (showProgress) setLoading(true);
    setError('');
    try {
      const next = await api<SocialExpense>(`/api/social/expenses/${id}`);
      if (current === generation.current) setExpense(next);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  loadCurrent.current = () => load(false);
  useEffect(() => {
    if (expense?.paymentEnvironment !== 'sandbox') return;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !cancelLock.current &&
        !paymentCheckLock.current
      )
        void loadCurrent.current();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [expense?.paymentEnvironment, id]);
  useEffect(() => {
    setExpense(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [id]);
  async function checkPayments() {
    if (!expense || paymentCheckLock.current || cancelLock.current) return;
    paymentCheckLock.current = true;
    setCheckingPayments(true);
    try {
      await Promise.all(
        expense.shares
          .filter(
            (share) => !['self', 'no_payment', 'canceled', 'invite_ready'].includes(share.status),
          )
          .map((share) => api(`/api/payments/sandbox/shares/${share.id}`)),
      );
      await load(false);
      await onUpdated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      paymentCheckLock.current = false;
      setCheckingPayments(false);
    }
  }
  async function cancel(share: SocialShare) {
    if (cancelLock.current || !expense) return;
    cancelLock.current = true;
    setCanceling(share.id);
    setError('');
    const current = generation.current;
    try {
      const next = await api<SocialExpense>(
        `/api/social/expenses/${id}/shares/${share.id}/cancel`,
        {},
      );
      if (current !== generation.current) return;
      setExpense(next);
      setConfirm(null);
      await onUpdated();
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      cancelLock.current = false;
      if (current === generation.current) setCanceling(null);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={expense?.title ?? 'A shared moment'}
      size="md"
      description={
        expense
          ? `${expense.isOwner ? 'You' : expense.paidByName} paid · ${shortDate(expense.createdAt)}`
          : undefined
      }
    >
      {loading && !expense ? (
        <div className="account-detail-loading" role="status">
          <span className="ui-spinner" /> Opening the details…
        </div>
      ) : expense ? (
        <div className="account-expense-detail">
          {expense.paymentEnvironment === 'sandbox' && (
            <span className="account-test-badge" style={{ alignSelf: 'center' }}>
              TEST SPLIT · NO REAL MONEY
            </span>
          )}
          <div className="account-receipt-header">
            <span aria-hidden="true">{expense.emoji}</span>
            <p>THE WHOLE MOMENT</p>
            <strong>{money(expense.totalMinor)}</strong>
            <span>
              {expense.method === 'equal'
                ? 'Split equally'
                : expense.method === 'items'
                  ? 'Split by what you shared'
                  : 'Everyone’s own share'}
            </span>
          </div>
          {expense.paymentEnvironment === 'sandbox' && expense.isOwner && <ShareReceivingSetup />}
          {expense.paymentEnvironment === 'sandbox' &&
            !expense.isOwner &&
            expense.shares
              .filter(
                (share) =>
                  share.isYou && !['self', 'no_payment', 'canceled'].includes(share.status),
              )
              .map((share) => (
                <SharePayment
                  key={share.id}
                  shareId={share.id}
                  payeeName={expense.paidByName}
                  title={expense.title}
                  onChanged={async () => {
                    await load(false);
                    await onUpdated();
                  }}
                />
              ))}
          <div className="account-shares">
            {expense.shares.map((share) => {
              const contact = contacts.find((person) => person.id === share.participantId);
              const canCancel =
                expense.isOwner &&
                !['self', 'no_payment', 'canceled'].includes(share.status) &&
                (expense.paymentEnvironment !== 'sandbox' ||
                  share.sandboxPayment?.canCancel === true);
              return (
                <div className="account-share" key={share.id}>
                  <div className="account-share-main">
                    <Avatar name={share.name} />
                    <div>
                      <strong>
                        {share.name}
                        {share.isYou && <span> · You</span>}
                      </strong>
                      <small>
                        {share.status === 'self'
                          ? 'Paid the bill'
                          : share.status === 'no_payment'
                            ? 'No payment needed'
                            : share.status === 'canceled'
                              ? 'Request canceled'
                              : share.status === 'invite_ready'
                                ? 'Invitation ready'
                                : expense.paymentEnvironment === 'sandbox'
                                  ? share.sandboxPayment?.status === 'paid'
                                    ? 'Test share paid'
                                    : share.sandboxPayment?.status === 'returned'
                                      ? 'Test payment returned · share open'
                                      : share.sandboxPayment?.status === 'failed'
                                        ? 'Test payment failed · share open'
                                        : share.sandboxPayment?.status === 'processing' ||
                                            share.sandboxPayment?.status === 'unknown'
                                          ? 'Checking test payment'
                                          : 'Test share to cover'
                                  : 'Saved · payment setup pending'}
                      </small>
                    </div>
                    <b>{money(share.amountMinor)}</b>
                  </div>
                  {expense.isOwner && share.status === 'invite_ready' && contact && (
                    <button
                      className="account-share-invite"
                      onClick={() => onInvite(contact, expense.id)}
                    >
                      Share {share.name.split(' ')[0]}’s invitation <ArrowUpRight size={15} />
                    </button>
                  )}
                  {canCancel &&
                    (confirm === share.id ? (
                      <div className="account-cancel-confirm">
                        <p>
                          Cancel {share.name.split(' ')[0]}’s {money(share.amountMinor)} request?
                          The receipt stays in your history.
                        </p>
                        <div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={canceling !== null}
                            onClick={() => setConfirm(null)}
                          >
                            Keep it
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={canceling === share.id}
                            disabled={canceling !== null && canceling !== share.id}
                            onClick={() => void cancel(share)}
                          >
                            Cancel request
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="account-cancel-trigger"
                        disabled={canceling !== null}
                        onClick={() => setConfirm(share.id)}
                      >
                        Cancel request
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
          {expense.paymentEnvironment === 'sandbox' && expense.isOwner && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} />}
              loading={checkingPayments}
              disabled={canceling !== null}
              onClick={() => void checkPayments()}
            >
              Check test repayments
            </Button>
          )}
          {expense.items.length > 0 && (
            <details className="account-item-details">
              <summary>
                <Receipt size={17} /> The receipt breakdown
              </summary>
              <div>
                {expense.items.map((item) => (
                  <div key={item.id}>
                    <span>
                      {item.name}
                      <small>
                        {item.participantIds
                          .map(
                            (personId) =>
                              expense.shares.find((share) => share.participantId === personId)
                                ?.name ?? 'Participant',
                          )
                          .join(', ')}
                      </small>
                    </span>
                    <b>{money(item.amountMinor)}</b>
                  </div>
                ))}
                <div>
                  <span>Tax</span>
                  <b>{money(expense.taxMinor)}</b>
                </div>
                <div>
                  <span>Tip</span>
                  <b>{money(expense.tipMinor)}</b>
                </div>
                {expense.discountMinor !== '0' && (
                  <div>
                    <span>Discount</span>
                    <b>−{money(expense.discountMinor)}</b>
                  </div>
                )}
              </div>
            </details>
          )}
          <div className="account-saved-note">
            <Check size={17} />
            <div>
              <strong>
                {expense.paymentEnvironment === 'sandbox'
                  ? 'A practice run, together.'
                  : 'Every share is saved.'}
              </strong>
              <p>
                {expense.paymentEnvironment === 'sandbox'
                  ? 'Each friend can approve their exact share using test dollars. This split stays separate from real balances.'
                  : 'Payments will open after our payment partner is ready. Nothing has been charged.'}
              </p>
            </div>
          </div>
          <p className="account-small-note">
            <LockKeyhole size={13} /> Verified participants can see these shares. Receipt photos
            stay private.
          </p>
        </div>
      ) : (
        <Button onClick={() => void load()}>Try opening this moment again</Button>
      )}
      {error && (
        <p className="account-inline-error" role="alert">
          <X size={15} />
          {error}
        </p>
      )}
    </Dialog>
  );
}
