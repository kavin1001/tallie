'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Fingerprint, RefreshCw } from 'lucide-react';
import { identityClient } from '@tallie/identity/client';
import type { OwnerPilotState } from '@tallie/payments/contracts';
import { errorMessage, money } from '@/lib/client';
import { useAccountApi } from '../account-context';
import { Button, Dialog } from '../ui';
import './owner-pilot.css';

const endpoint = '/api/payments/owner-pilot';
const settled = new Set(['COMPLETED', 'FAILED', 'RETURNED', 'APPROVAL_DENIED', 'CANCELED']);
const statusText: Record<string, { title: string; detail: string }> = {
  COMPLETED: {
    title: 'A little hello, delivered.',
    detail: 'Natural confirmed this payment is complete.',
  },
  RETURNED: {
    title: 'This payment was returned.',
    detail: 'Check your Natural wallet for the returned funds. No replacement was sent.',
  },
  FAILED: {
    title: 'This payment didn’t complete.',
    detail: 'Natural reported a failure. No replacement will be sent automatically.',
  },
  APPROVAL_DENIED: {
    title: 'Payment wasn’t approved.',
    detail: 'Natural declined the approval. No replacement will be sent automatically.',
  },
  CANCELED: {
    title: 'Payment canceled.',
    detail: 'Natural confirmed the cancellation. No replacement was sent.',
  },
  PENDING_CLAIM: {
    title: 'Waiting to be claimed.',
    detail: 'Natural is holding this payment for the recipient to claim.',
  },
  IN_REVIEW: {
    title: 'Natural is reviewing it.',
    detail: 'Your payment is saved. We’ll check for an update.',
  },
  unknown: {
    title: 'Checking what happened.',
    detail: 'The response was interrupted. We’ll check this same payment; we won’t send another.',
  },
};

export function OwnerPilot({ accountId }: { accountId: string }) {
  const api = useAccountApi();
  const [state, setState] = useState<OwnerPilotState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const load = useCallback(
    async (reconcile = false) => {
      const next = await api<OwnerPilotState>(
        reconcile ? `${endpoint}/refresh` : endpoint,
        reconcile ? {} : undefined,
      );
      if (active.current) {
        setState(next);
        setUncertain(false);
        setError('');
      }
    },
    [api],
  );
  useEffect(() => {
    active.current = true;
    void load().catch((cause: unknown) => {
      if (active.current) setError(errorMessage(cause));
    });
    return () => {
      active.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!state?.transfer || settled.has(state.transfer.status)) return;
    const timer = setTimeout(() => {
      if (lock.current) return;
      void load(true).catch((cause: unknown) => {
        if (active.current) setError(errorMessage(cause));
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [state, load]);

  async function run(action: 'review' | 'confirm' | 'refresh') {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'refresh') {
        await load(true);
        return;
      }
      if (action === 'review') {
        const proof = await identityClient.signIn.passkey({
          fetchOptions: { headers: { 'X-Tallie-Account': accountId } },
        });
        if (proof.error) throw new Error('Use your Tallie passkey to review this payment.');
      }
      if (action === 'confirm' && (!state?.review || uncertain)) return;
      if (action === 'confirm')
        setState((current) => (current ? { ...current, availableMinor: null } : current));
      const next = await api<OwnerPilotState>(
        `${endpoint}/${action}`,
        action === 'review' ? {} : { reviewId: state!.review!.id },
      );
      if (!active.current) return;
      setState(next);
      setOpen(action === 'review' && Boolean(next.review));
      setUncertain(false);
    } catch (cause) {
      if (active.current) {
        setError(errorMessage(cause));
        if (action === 'confirm') {
          setUncertain(true);
          setOpen(false);
        }
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }

  const amount = money(BigInt(state?.amountMinor ?? 100));
  const transfer = state?.transfer;
  const status = transfer
    ? (statusText[transfer.status] ?? {
        title: 'Sending your little hello.',
        detail: 'Your payment is saved and processing. We’re checking with Natural.',
      })
    : null;
  const expired = state?.review ? Date.parse(state.review.expiresAt) <= Date.now() : false;
  return (
    <section className="owner-pilot" aria-labelledby="owner-pilot-title">
      <div className="owner-pilot__top">
        <span className="owner-pilot__eyebrow">PERSONAL PAYMENT TEST</span>
        <span className="owner-pilot__badge">Real money</span>
      </div>
      <div className="owner-pilot__body">
        <span className="owner-pilot__icon" aria-hidden="true">
          {transfer?.status === 'COMPLETED' ? <Check size={24} /> : <ArrowUpRight size={24} />}
        </span>
        <div>
          <h2 id="owner-pilot-title">{status?.title ?? 'Your first little send.'}</h2>
          <p>{status?.detail ?? 'Your existing Natural wallet, right here in Tallie.'}</p>
        </div>
      </div>
      {state && (
        <div className="owner-pilot__payment">
          <span>
            {transfer ? 'Payment to' : 'Ready for'} <strong>{state.recipientHandle}</strong>
          </span>
          <strong>{amount}</strong>
        </div>
      )}
      <div aria-live="polite">
        {transfer?.needsStatusCheck && (
          <p className="owner-pilot__note">
            The latest status check needs attention. The status above is the last verified result.
            Check again before relying on it.
          </p>
        )}
        {error && (
          <p className="owner-pilot__error" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <p className="owner-pilot__note">
            Check the saved status before continuing. No replacement payment will be created.
          </p>
        )}
      </div>
      <div className="owner-pilot__footer">
        <span>
          {state?.availableMinor == null
            ? 'One payment · your approval'
            : `${money(BigInt(state.availableMinor))} available in Natural`}
        </span>
        {transfer || uncertain || !state ? (
          <Button
            variant="secondary"
            loading={busy}
            icon={<RefreshCw size={15} />}
            onClick={() => void run('refresh')}
          >
            Check status
          </Button>
        ) : (
          <Button
            loading={busy}
            icon={<ArrowUpRight size={16} />}
            onClick={() => void run('review')}
          >
            Review {amount}
          </Button>
        )}
      </div>
      {transfer?.feeMinor != null && (
        <p className="owner-pilot__note">Natural fee: {money(BigInt(transfer.feeMinor))}</p>
      )}
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="A little hello, on you."
      >
        <div className="owner-pilot__review">
          <span className="owner-pilot__badge">Real money · one-time test</span>
          <div className="owner-pilot__amount">{amount}</div>
          <p className="owner-pilot__recipient">
            to <strong>{state?.review?.recipientHandle}</strong>
          </p>
          <dl>
            <div>
              <dt>From</dt>
              <dd>Your Natural wallet</dd>
            </div>
            <div>
              <dt>Tallie fee</dt>
              <dd>$0.00</dd>
            </div>
            <div>
              <dt>Expected Natural fee</dt>
              <dd>$0.00</dd>
            </div>
          </dl>
          <p className="owner-pilot__note">
            Natural lists consumer payments as free. This sends real dollars to the Natural handle
            shown above. Check it carefully before approving.
          </p>
          <p className="owner-pilot__secure">
            <Fingerprint size={17} /> Confirmed with your Tallie passkey
          </p>
          {error && (
            <p role="alert" className="owner-pilot__error">
              {error}
            </p>
          )}
          <Button
            fullWidth
            loading={busy}
            disabled={!state?.review || expired || uncertain}
            onClick={() => void run('confirm')}
          >
            Send {amount}
          </Button>
          {expired && (
            <p className="owner-pilot__note">This review expired. Close it and review again.</p>
          )}
          <Button fullWidth variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            Not now
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
