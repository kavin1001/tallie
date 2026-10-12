'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ProductionConnectionState } from '@tallie/payments/contracts';
import { errorMessage } from '@/lib/client';
import { useAccountApi } from '../account-context';
import { Button } from '../ui';
import './payments-connect.css';

const descriptions = {
  inviting: ['Getting your invitation ready.', 'You can leave this page. Your progress is saved.'],
  pending: [
    'A quick introduction.',
    'Continue with Natural to verify your details and connect your payment account.',
  ],
  verifying: [
    'Checking the last few details.',
    'We’re waiting for confirmation from Natural. Your progress is saved.',
  ],
  connected: [
    'You’re connected.',
    'Your payment account is connected. Sending, adding money, and cashing out are not available yet.',
  ],
  unknown: [
    'Your setup is saved.',
    'We haven’t confirmed the result yet. Check again in a moment; you don’t need to start over.',
  ],
  blocked: [
    'Let’s get this sorted.',
    'We couldn’t verify your connection. Please contact the person who invited you to Tallie for help.',
  ],
  expired: [
    'This invitation has expired.',
    'Your Tallie account is safe. Please contact the person who invited you for help continuing setup.',
  ],
} as const;

const checkedMessages = {
  inviting: 'Setup checked. Your invitation is still being prepared. Your progress is saved.',
  pending: 'Setup checked. We’re still waiting for Natural to confirm your connection.',
  verifying: 'Setup checked. We’re verifying Natural’s confirmation. Please check again shortly.',
  connected: 'All set. Your payment account is connected.',
  unknown: 'Setup checked. We haven’t received confirmation yet. Your progress is saved.',
  blocked:
    'Setup checked. We still couldn’t verify your connection. Please contact the person who invited you for help.',
  expired: 'Setup checked. This invitation has expired. Contact your inviter for help continuing.',
} as const;
type SetupAction = 'read' | 'start' | 'refresh';
type ConnectionStatus = NonNullable<ProductionConnectionState['connection']>['status'];

/** Navigation is never acceptance. Only saved, verified server state can say connected. */
export function PaymentsConnect({
  onSecurity,
  returnState,
}: {
  onSecurity: () => void;
  returnState?: string;
}) {
  const api = useAccountApi();
  const heading = useId();
  const [state, setState] = useState<ProductionConnectionState | null>(null);
  const [activeAction, setActiveAction] = useState<SetupAction | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<{
    status: ConnectionStatus | undefined;
    message: string;
  } | null>(null);
  const busy = activeAction !== null;
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const returnMatched = useRef(false);
  const mounted = useRef(false);

  const run = useCallback(
    async (action: SetupAction) => {
      if (active.current || !mounted.current) return;
      const controller = new AbortController();
      active.current = controller;
      const version = generation.current;
      setActiveAction(action);
      setError('');
      if (action !== 'read') setFeedback(null);
      try {
        if (returnState && !returnMatched.current) {
          await api(
            '/api/payments/production/connect/return',
            { state: returnState },
            undefined,
            controller.signal,
          );
          if (!mounted.current || generation.current !== version) return;
          returnMatched.current = true;
          window.history.replaceState(null, '', '/payments/connect/return');
        }
        const next = await api<ProductionConnectionState>(
          action === 'read'
            ? '/api/payments/production/connect'
            : `/api/payments/production/connect/${action}`,
          action === 'read' ? undefined : {},
          undefined,
          controller.signal,
        );
        if (mounted.current && generation.current === version) {
          setState(next);
          const nextStatus = next.connection?.status;
          setFeedback((current) =>
            action === 'refresh'
              ? {
                  status: nextStatus,
                  message: nextStatus
                    ? checkedMessages[nextStatus]
                    : 'Setup checked. You’re ready to connect your payment account.',
                }
              : current?.status === nextStatus
                ? current
                : null,
          );
        }
      } catch (cause) {
        if (mounted.current && generation.current === version) {
          // A lost response must not offer another invitation. Read saved state first.
          setState(null);
          setFeedback(null);
          setError(errorMessage(cause));
        }
      } finally {
        if (mounted.current && generation.current === version) {
          active.current = null;
          setActiveAction(null);
        }
      }
    },
    [api, returnState],
  );

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    returnMatched.current = false;
    setState(null);
    setFeedback(null);
    void run('read');
    return () => {
      mounted.current = false;
      generation.current++;
      active.current?.abort();
      active.current = null;
    };
  }, [run]);

  const status = state?.connection?.status;
  useEffect(() => {
    if (!status || !['pending', 'inviting', 'verifying'].includes(status)) return;
    const until = Date.now() + 120_000;
    const timer = setInterval(() => {
      if (Date.now() >= until) clearInterval(timer);
      else if (document.visibilityState === 'visible') void run('read');
    }, 5_000);
    return () => clearInterval(timer);
  }, [status, run]);

  if (state && !state.available) return null;
  const [title, description] = status
    ? descriptions[status]
    : [
        'Make room for easier payments.',
        'Connect your account with Natural, our payment partner. You’ll always review and approve a payment before sending it.',
      ];
  const initial = state !== null && state.connection === null;
  const url = state?.connection?.invitationUrl;
  return (
    <section className="payments-connect" aria-labelledby={heading} aria-busy={busy}>
      <div className="payments-connect-icon" aria-hidden="true">
        {status === 'connected' ? <Check size={23} /> : <ShieldCheck size={23} />}
      </div>
      <div className="payments-connect-copy">
        <span className="payments-connect-eyebrow">YOUR PAYMENT ACCOUNT</span>
        <h2 id={heading}>{title}</h2>
        <p>{description}</p>
        <div className="payments-connect-actions">
          {initial ? (
            <Button loading={busy} onClick={() => void run('start')}>
              Set up payments <ArrowUpRight size={16} aria-hidden="true" />
            </Button>
          ) : url ? (
            <a className="payments-connect-link" href={url} rel="noreferrer">
              Continue with Natural <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          ) : null}
          {status !== 'connected' && (
            <Button
              variant="ghost"
              disabled={busy}
              loading={activeAction === 'refresh'}
              icon={<RefreshCw size={14} aria-hidden="true" />}
              onClick={() => void run('refresh')}
            >
              {activeAction === 'refresh' ? 'Checking setup…' : 'Check setup'}
            </Button>
          )}
          <button className="text-action" disabled={busy} onClick={onSecurity}>
            Sign-in & security
          </button>
        </div>
        <p
          className="payments-connect-feedback"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {activeAction === 'refresh' ? 'Checking your connection…' : feedback?.message}
        </p>
        {error && (
          <p className="payments-connect-error" role="alert">
            {error}
          </p>
        )}
        {status !== 'connected' && (
          <small>Setup doesn’t send money. Payments are not open yet.</small>
        )}
      </div>
    </section>
  );
}
