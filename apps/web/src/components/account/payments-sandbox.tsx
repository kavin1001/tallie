'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, RefreshCw, Sparkles } from 'lucide-react';
import type { SandboxAccountState, SandboxConnectionStatus } from '@tallie/payments/contracts';
import { errorMessage, money } from '@/lib/client';
import { useAccountApi } from '../account-context';
import { Flower } from '../brand';
import { Button } from '../ui';
import { SandboxSend } from './sandbox-send';
import './payments-sandbox.css';

type Action = 'read' | 'start' | 'retry' | 'refresh';

const setupCopy: Record<SandboxConnectionStatus, { title: string; description: string }> = {
  prepared: {
    title: 'A little preparation.',
    description: 'Your test account setup is saved. Check back in a moment for the next step.',
  },
  inviting: {
    title: 'Making room for your test account.',
    description: 'We’re creating your account in Natural’s sandbox. This can take a moment.',
  },
  accepting: {
    title: 'Putting the pieces together.',
    description: 'We’re connecting your test account. No real money is involved.',
  },
  verifying: {
    title: 'One last check.',
    description: 'We’re checking your connection and test balances with Natural.',
  },
  connected: {
    title: 'Your test account is ready.',
    description: 'A first look at payments on Tallie. Every dollar here is a test dollar.',
  },
  unknown: {
    title: 'Still waiting for the all clear.',
    description: 'Setup may have reached Natural, but we haven’t confirmed the result yet.',
  },
  blocked: {
    title: 'This needs a closer look.',
    description: 'We couldn’t confirm a usable test connection. Setup is paused for review.',
  },
};

/** Opt-in provider sandbox setup. Mounting this card only reads Tallie's saved state. */
export function PaymentsSandbox() {
  const api = useAccountApi();
  const headingId = useId();
  const [state, setState] = useState<SandboxAccountState | null>(null);
  const [busy, setBusy] = useState<Action | null>('read');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    const version = ++sequence.current;
    const controller = new AbortController();
    active.current = controller;
    setState(null);
    setBusy('read');
    setError('');
    setUncertain(false);
    void api<SandboxAccountState>('/api/payments/sandbox', undefined, undefined, controller.signal)
      .then((next) => {
        if (mounted.current && version === sequence.current) setState(next);
      })
      .catch((cause: unknown) => {
        if (mounted.current && version === sequence.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted.current && version === sequence.current) {
          active.current = null;
          setBusy(null);
        }
      });
    return () => {
      mounted.current = false;
      sequence.current++;
      active.current?.abort();
      active.current = null;
    };
  }, [api]);

  async function run(action: Action) {
    if (active.current || !mounted.current) return;
    const controller = new AbortController();
    active.current = controller;
    const version = ++sequence.current;
    setBusy(action);
    setError('');
    try {
      const next = await api<SandboxAccountState>(
        action === 'read' ? '/api/payments/sandbox' : `/api/payments/sandbox/${action}`,
        action === 'read' ? undefined : {},
        undefined,
        controller.signal,
      );
      if (!mounted.current || version !== sequence.current) return;
      setState(next);
      setUncertain(false);
    } catch (cause) {
      if (!mounted.current || version !== sequence.current) return;
      setState(null);
      setError(errorMessage(cause));
      if (action !== 'read') setUncertain(true);
    } finally {
      if (mounted.current && version === sequence.current) {
        active.current = null;
        setBusy(null);
      }
    }
  }

  if (state && !state.available) return null;

  const connection = state?.connection;
  const connected = connection?.status === 'connected';
  const initial = Boolean(state && !connection);
  const copy = connection ? setupCopy[connection.status] : null;
  const title =
    copy?.title ?? (uncertain ? 'Let’s check where things landed.' : 'A little room to try.');
  const description =
    copy?.description ??
    (uncertain
      ? 'The connection dropped before we heard back. Check your saved setup before continuing.'
      : 'Create a test account to explore your Tallie balance. Real payments are still to come.');

  return (
    <section className="payments-sandbox" aria-labelledby={headingId}>
      <div className="payments-sandbox-topline">
        <span className="payments-sandbox-label">
          <Sparkles size={13} aria-hidden="true" /> PAYMENTS SANDBOX
        </span>
        <span className="payments-sandbox-test">Test money only</span>
      </div>
      <div className="payments-sandbox-intro">
        <div className="payments-sandbox-token" aria-hidden="true">
          {connected ? <Check size={24} strokeWidth={1.5} /> : <Flower />}
        </div>
        <div>
          <h2 id={headingId}>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {connected && (
        <div className="payments-sandbox-wallets">
          {connection.balances.length ? (
            connection.balances.map((balance, index) => (
              <div className="payments-sandbox-wallet" key={balance.id}>
                <span>
                  {connection.balances.length === 1 ? 'Test balance' : `Test wallet ${index + 1}`}
                </span>
                {balance.availableMinor === null ? (
                  <strong className="payments-sandbox-unavailable">Balance unavailable</strong>
                ) : (
                  <strong>{money(balance.availableMinor)}</strong>
                )}
                <p>
                  {balance.availableMinor === null
                    ? 'Check again in a moment.'
                    : 'Available test dollars'}
                </p>
                <small>
                  {balance.totalMinor === null
                    ? 'Total test balance unavailable'
                    : `${money(balance.totalMinor)} total test balance`}
                </small>
              </div>
            ))
          ) : (
            <p className="payments-sandbox-empty">
              Your connection is ready. No usable test wallets are available yet.
            </p>
          )}
        </div>
      )}
      {connected && (
        <p className="payments-sandbox-checked">
          Last checked{' '}
          <time dateTime={connection.updatedAt}>
            {new Date(connection.updatedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </p>
      )}
      <div className="payments-sandbox-actions">
        {initial && !uncertain ? (
          <Button
            loading={busy === 'start'}
            disabled={busy !== null}
            onClick={() => void run('start')}
          >
            Create test account <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : connected ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} aria-hidden="true" />}
            loading={busy === 'refresh'}
            disabled={busy !== null}
            onClick={() => void run('refresh')}
          >
            Refresh test balances
          </Button>
        ) : (
          <>
            {connection?.retryAllowed && (
              <Button
                loading={busy === 'retry'}
                disabled={busy !== null}
                onClick={() => void run('retry')}
              >
                Continue setup <ArrowRight size={16} aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} aria-hidden="true" />}
              loading={busy === 'read'}
              disabled={busy !== null}
              onClick={() => void run('read')}
            >
              Check setup
            </Button>
          </>
        )}
        <span className="payments-sandbox-footnote">No real money can move here.</span>
      </div>
      {connected && <SandboxSend />}
      <span className="visually-hidden" role="status" aria-live="polite">
        {busy === 'read'
          ? 'Checking saved test account setup.'
          : busy === 'refresh'
            ? 'Refreshing test balances.'
            : busy
              ? 'Setting up your test account.'
              : (copy?.title ?? '')}
      </span>
      {error && (
        <p className="payments-sandbox-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
