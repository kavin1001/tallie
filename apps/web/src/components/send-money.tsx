'use client';
import { useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { Dashboard, PaymentReview, Person } from '@tallie/db/contracts';
import { Avatar, Button, Dialog } from './ui';
import { api, cents, errorMessage } from '@/lib/client';
export function SendMoney({
  data,
  initialPerson,
  onClose,
  onReview,
}: {
  data: Dashboard;
  initialPerson?: Person | undefined;
  onClose: () => void;
  onReview: (review: PaymentReview) => void;
}) {
  const [recipientId, setRecipientId] = useState(initialPerson?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const amountInput = useRef<HTMLInputElement>(null);
  let enteredAmount: string | null = null;
  try {
    enteredAmount = cents(amount);
  } catch {
    /* An incomplete amount has no matching request. */
  }
  const matchingRequest = data.requests.find(
    (request) =>
      request.from.id === recipientId &&
      request.to.id === data.user.id &&
      request.amountMinor === enteredAmount &&
      ['open', 'processing', 'issue'].includes(request.status),
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (!recipientId) throw new Error('Choose who you’d like to send money to.');
      const amountMinor = cents(amount);
      if (BigInt(amountMinor) <= 0n) throw new Error('Enter an amount greater than $0.00.');
      onReview(
        matchingRequest
          ? await api<PaymentReview>(`/api/requests/${matchingRequest.id}/review`, {})
          : await api<PaymentReview>('/api/sends/review', {
              recipientId,
              amountMinor,
              note: note.trim(),
            }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      initialFocusRef={amountInput}
      onClose={onClose}
      title="A little something."
      description="For a favor, a coffee, or just because."
      size="sm"
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="composer-fields">
          <div className="form-field">
            <span className="field-label">Who’s it for?</span>
            <div className="send-people">
              {data.people
                .filter((p) => p.id !== data.user.id)
                .map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={recipientId === person.id ? 'selected' : ''}
                    aria-pressed={recipientId === person.id}
                    onClick={() => setRecipientId(person.id)}
                  >
                    <Avatar name={person.name} size="md" />
                    <span>{person.firstName}</span>
                    {recipientId === person.id && <Check size={12} />}
                  </button>
                ))}
            </div>
          </div>
          <div className="amount-field">
            <label htmlFor="send-amount">How much?</label>
            <div>
              <span>$</span>
              <input
                ref={amountInput}
                id="send-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <small>USD</small>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="send-note">
              A little note <span className="optional">optional</span>
            </label>
            <input
              id="send-note"
              maxLength={100}
              placeholder="Thanks for the coffee ☕"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </fieldset>
        {matchingRequest && (
          <p className="form-hint">
            This matches your “{matchingRequest.title}” request.{' '}
            {matchingRequest.status === 'open'
              ? 'We’ll use that request so you don’t pay twice.'
              : 'It is already processing or needs attention. Open the split for its current status.'}
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <Button
          fullWidth
          size="lg"
          type="submit"
          loading={busy}
          disabled={Boolean(matchingRequest && matchingRequest.status !== 'open')}
        >
          {matchingRequest ? 'Review existing request' : 'Review payment'} <ArrowRight size={17} />
        </Button>
        <p className="approval-note">
          You’ll approve the exact details next. No real money moves in this demo.
        </p>
      </form>
    </Dialog>
  );
}
