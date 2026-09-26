'use client';
import { useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Flag, Receipt, X } from 'lucide-react';
import type { Allocation, Dashboard, ExpenseSummary, PaymentRequest } from '@tallie/db/contracts';
import { Avatar, Button, Dialog, useToast } from './ui';
import { api, errorMessage, money, shortDate } from '@/lib/client';
import { Flower } from './brand';

const shareStatusLabels: Record<Allocation['status'], string> = {
  self: 'Originally paid',
  no_payment: 'No payment needed',
  paid: 'Paid · demo',
  processing: 'On its way',
  canceled: 'Request canceled',
  issue: 'Needs a look',
  open: 'To settle',
};

export function ExpenseDetail({
  expense,
  requests,
  data,
  reviewing,
  onClose,
  onPay,
  onChanged,
}: {
  expense: ExpenseSummary;
  requests: PaymentRequest[];
  data: Dashboard;
  reviewing: string | null;
  onClose: () => void;
  onPay: (request: PaymentRequest) => Promise<void>;
  onChanged: () => Promise<unknown>;
}) {
  const [showReceipt, setShowReceipt] = useState(true);
  const [action, setAction] = useState<{
    request: PaymentRequest;
    kind: 'cancel' | 'issue';
  } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();
  const mine = requests.find((r) => r.to.id === data.user.id);
  async function performAction() {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        `/api/requests/${action.request.id}/${action.kind === 'issue' ? 'issues' : 'cancel'}`,
        {
          expectedVersion: action.request.version,
          ...(action.kind === 'issue' ? { reason: reason.trim() } : {}),
        },
      );
      await onChanged();
      setAction(null);
      setReason('');
      toast({
        title: action.kind === 'cancel' ? 'Request canceled.' : 'Thanks for speaking up.',
        description:
          action.kind === 'issue'
            ? 'This request is on hold while the details are resolved.'
            : 'The expense history is kept for everyone.',
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={expense.title}
      description={`${expense.paidBy.id === data.user.id ? 'You' : expense.paidBy.firstName} paid · ${shortDate(expense.createdAt)} · ${expense.participants.length} people`}
      size="md"
    >
      <div className="expense-detail-hero">
        <span>{expense.status === 'settled' ? <Check size={24} /> : <Receipt size={24} />}</span>
        <div className="detail-total">{money(expense.totalMinor)}</div>
        <span className={`detail-status ${expense.status === 'settled' ? 'is-settled' : ''}`}>
          {expense.status === 'settled'
            ? 'All square. A good feeling.'
            : expense.status === 'canceled'
              ? 'Closed with a canceled request'
              : expense.method === 'equal'
                ? 'Shared equally'
                : expense.method === 'items'
                  ? 'Shared by item'
                  : 'Shared your way'}
        </span>
      </div>
      <section className="detail-shares">
        <div className="detail-section-heading">
          <h3>The whole picture</h3>
          <span>Nothing to guess.</span>
        </div>
        {expense.participants.map((allocation) => {
          const request = requests.find((r) => r.id === allocation.requestId);
          return (
            <div className="detail-share-row" key={allocation.person.id}>
              <Avatar name={allocation.person.name} />
              <div className="detail-person">
                <strong>
                  {allocation.person.id === data.user.id ? 'You' : allocation.person.name}
                </strong>
                <span>{shareStatusLabels[allocation.status]}</span>
              </div>
              <b>{money(allocation.amountMinor)}</b>
              {allocation.status === 'paid' ||
              allocation.status === 'self' ||
              allocation.status === 'no_payment' ? (
                <span className="share-check">
                  <Check size={15} />
                </span>
              ) : request?.allowedActions.includes('cancel_request') ? (
                <button
                  className="icon-button"
                  aria-label={`Cancel request to ${allocation.person.firstName}`}
                  onClick={() => {
                    setAction({ request, kind: 'cancel' });
                    setError('');
                  }}
                >
                  <X size={16} />
                </button>
              ) : (
                <span className="share-dot" />
              )}
            </div>
          );
        })}
      </section>
      {requests
        .filter((request) => request.status === 'issue' && request.issueReason)
        .map((request) => (
          <section className="issue-note" key={request.id}>
            <div>
              <Flag size={15} />
              <strong>
                {request.to.id === data.user.id ? 'You' : request.to.firstName} asked for a second
                look
              </strong>
            </div>
            <p>{request.issueReason}</p>
            <small>
              This request is paused. The original payer can cancel it and create a corrected split.
            </small>
          </section>
        ))}
      <button
        className="receipt-toggle"
        onClick={() => setShowReceipt((value) => !value)}
        aria-expanded={showReceipt}
      >
        <Receipt size={17} />
        <span>{expense.receiptKind === 'demo' ? 'Sample receipt' : 'Expense breakdown'}</span>
        {showReceipt ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
      </button>
      {showReceipt && (
        <div className="detail-receipt">
          <Flower />
          <h3>{expense.title}</h3>
          <span className="receipt-subtitle">
            {expense.receiptKind === 'demo' ? 'SYNTHETIC DEMO RECEIPT' : 'EXPENSE DETAILS'}
          </span>
          <div className="receipt-rule" />
          {expense.items.length ? (
            expense.items.map((item) => (
              <div className="detail-receipt-item" key={item.id}>
                <div>
                  <span>{item.name}</span>
                  <small>
                    {item.participantIds
                      .map(
                        (id) =>
                          expense.participants.find((p) => p.person.id === id)?.person.firstName,
                      )
                      .filter(Boolean)
                      .join(', ')}
                  </small>
                </div>
                <b>{money(item.amountMinor)}</b>
              </div>
            ))
          ) : (
            <div className="detail-receipt-item">
              <span>Shared expense</span>
              <b>{money(expense.subtotalMinor)}</b>
            </div>
          )}
          {BigInt(expense.taxMinor) > 0n && (
            <div className="detail-receipt-item">
              <span>Tax</span>
              <b>{money(expense.taxMinor)}</b>
            </div>
          )}
          {BigInt(expense.tipMinor) > 0n && (
            <div className="detail-receipt-item">
              <span>Tip</span>
              <b>{money(expense.tipMinor)}</b>
            </div>
          )}
          {BigInt(expense.discountMinor) > 0n && (
            <div className="detail-receipt-item">
              <span>Discount</span>
              <b>−{money(expense.discountMinor)}</b>
            </div>
          )}
          <div className="receipt-rule" />
          <div className="detail-receipt-item receipt-final">
            <strong>Total</strong>
            <strong>{money(expense.totalMinor)}</strong>
          </div>
          <span className="receipt-bottom">GOOD MEMORIES. CLEAR NUMBERS.</span>
        </div>
      )}
      {mine?.allowedActions.includes('review_payment') && (
        <div className="detail-pay">
          <Button fullWidth size="lg" loading={reviewing === mine.id} onClick={() => onPay(mine)}>
            Review your {money(mine.amountMinor)} payment <ArrowUpRight size={18} />
          </Button>
          <button
            className="issue-link"
            onClick={() => {
              setAction({ request: mine, kind: 'issue' });
              setError('');
            }}
          >
            <Flag size={13} />
            Something doesn’t look right
          </button>
        </div>
      )}
      {action && (
        <section className="inline-confirm">
          <h3>
            {action.kind === 'cancel'
              ? `Cancel ${action.request.to.firstName}’s request?`
              : 'Let’s get it right.'}
          </h3>
          <p>
            {action.kind === 'cancel'
              ? 'They won’t be asked to pay this share. The original split remains in the history.'
              : 'Tell us what’s off. We’ll pause this request while the details are resolved.'}
          </p>
          {action.kind === 'issue' && (
            <label className="form-field">
              What needs a look?
              <textarea
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="For example, I didn’t have the wine."
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <Button variant="ghost" onClick={() => setAction(null)} disabled={busy}>
              Go back
            </Button>
            <Button
              variant={action.kind === 'cancel' ? 'danger' : 'primary'}
              loading={busy}
              disabled={action.kind === 'issue' && !reason.trim()}
              onClick={performAction}
            >
              {action.kind === 'cancel' ? 'Cancel request' : 'Raise an issue'}
            </Button>
          </div>
        </section>
      )}
      <p className="fine-print">
        Everyone in this split sees the same breakdown. No receipt photo is shared with this split.
      </p>
    </Dialog>
  );
}
