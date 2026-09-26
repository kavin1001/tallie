'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Clock3, ShieldCheck } from 'lucide-react';
import type { Operation, PaymentReview } from '@tallie/db/contracts';
import { Avatar, Button, Dialog } from './ui';
import { Flower } from './brand';
import { api, errorMessage, money, RequestError } from '@/lib/client';

export function PaymentFlow({
  review,
  onClose,
  onChanged,
}: {
  review: PaymentReview;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const scene = useRef<HTMLDivElement>(null);
  const key = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const completed = operation?.status === 'completed';
  const pending = operation?.status === 'queued' || operation?.status === 'processing';
  const changed = useRef(onChanged);
  useEffect(() => {
    if (completed)
      scene.current?.closest('.ui-dialog-content')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [completed]);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    if (!operation || !pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const poll = async () => {
      try {
        const next = await api<Operation>(`/api/operations/${operation.id}`);
        if (stopped) return;
        setOperation(next);
        if (next.status === 'completed' || next.status === 'failed') {
          await changed.current();
          return;
        }
        if (++polls >= 25) {
          setPollFailed(true);
          return;
        }
        timer = setTimeout(poll, 1200);
      } catch {
        if (!stopped) setPollFailed(true);
      }
    };
    timer = setTimeout(poll, 700);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operation?.id, pending, pollEpoch]);
  async function authorize() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await api<Operation>(
        `/api/payment-reviews/${review.id}/authorize`,
        { reviewDigest: review.reviewDigest },
        key.current,
      );
      setOperation(next);
      setUncertain(false);
      await onChanged().catch(() => undefined);
    } catch (e) {
      const ambiguous = !(e instanceof RequestError && e.status >= 400 && e.status < 500);
      setUncertain(ambiguous);
      setError(
        ambiguous
          ? 'We couldn’t confirm the result. Retry safely to retrieve the same payment. Your approval will not create a second payment.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy && !uncertain) onClose();
      }}
      title={
        completed
          ? 'A little less between you.'
          : operation
            ? 'On its way.'
            : 'A little moment of clarity.'
      }
      description={
        completed
          ? 'All square. Back to the good stuff.'
          : operation
            ? 'Your approval is in. We’re finishing the demo payment.'
            : 'Everything you need to know before you say yes.'
      }
      size="sm"
    >
      <div ref={scene} className={`payment-scene ${completed ? 'payment-complete' : ''}`}>
        {completed ? (
          <div className="success-flower">
            <Flower />
            <Check size={25} />
            <span className="confetti c-one" />
            <span className="confetti c-two" />
            <span className="confetti c-three" />
            <span className="confetti c-four" />
          </div>
        ) : (
          <div className="payment-people">
            <Avatar name={review.from.name} size="lg" />
            <span>{pending ? <span className="ui-spinner" /> : <ArrowRight size={20} />}</span>
            <Avatar name={review.to.name} size="lg" />
          </div>
        )}
        <p role={completed ? 'status' : undefined}>
          {completed ? `You sent ${review.to.firstName}` : `To ${review.to.name}`}
        </p>
        <div className="payment-amount">{money(review.totalMinor)}</div>
        <span className="payment-note">{review.note || 'Just because.'}</span>
      </div>
      <div className="payment-summary">
        <div>
          <span>From</span>
          <strong>{review.source.label}</strong>
        </div>
        <div>
          <span>Payment</span>
          <strong>{money(review.amountMinor)}</strong>
        </div>
        <div>
          <span>Demo fee</span>
          <strong>{money(review.feeMinor)}</strong>
        </div>
        <div className="summary-total">
          <span>Total</span>
          <strong>{money(review.totalMinor)}</strong>
        </div>
      </div>
      <p className="payment-assurance">
        <ShieldCheck size={16} />
        {completed
          ? 'Simulated payment completed. No real money moved.'
          : 'A demo payment. No real money will move.'}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {operation?.status === 'failed' && (
        <p className="form-error" role="alert">
          This demo payment didn’t complete. Close this view and review the request again.
        </p>
      )}
      {completed ? (
        <Button fullWidth size="lg" onClick={onClose}>
          Lovely. <Check size={18} />
        </Button>
      ) : pending ? (
        <>
          <div className="processing-note" role="status">
            <Clock3 size={17} />
            {pollFailed
              ? 'Still waiting for a confirmed result.'
              : 'Taking care of the last little detail…'}
          </div>
          {pollFailed && (
            <Button
              variant="secondary"
              fullWidth
              onClick={() => {
                setPollFailed(false);
                setPollEpoch((v) => v + 1);
              }}
            >
              Check payment status
            </Button>
          )}
          <Button variant="ghost" fullWidth onClick={onClose}>
            Back to your moments
          </Button>
        </>
      ) : operation?.status === 'failed' ? (
        <Button fullWidth onClick={onClose}>
          Back to your moments
        </Button>
      ) : (
        <Button fullWidth size="lg" loading={busy} onClick={authorize}>
          {uncertain ? 'Retry safely' : `Approve ${money(review.totalMinor)}`}
          <ArrowUpRight size={18} />
        </Button>
      )}
      {!operation && (
        <p className="approval-note">This approval is for this exact amount and person.</p>
      )}
    </Dialog>
  );
}
