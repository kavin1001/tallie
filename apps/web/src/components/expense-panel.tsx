'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard, ExpenseDetailData, PaymentRequest } from '@tallie/db/contracts';
import { api, errorMessage, RequestError } from '@/lib/client';
import { ExpenseDetail } from './expense-detail';
import { Flower } from './brand';
import { Button, Dialog } from './ui';

/** Expense actions use a complete authorized snapshot, independent of dashboard pagination. */
export function ExpensePanel({
  expenseId,
  data,
  reviewing,
  onClose,
  onPay,
  onChanged,
  onSessionExpired,
}: {
  expenseId: string;
  data: Dashboard;
  reviewing: string | null;
  onClose: () => void;
  onPay: (request: PaymentRequest) => Promise<void>;
  onChanged: () => Promise<unknown>;
  onSessionExpired: () => void;
}) {
  const [detail, setDetail] = useState<ExpenseDetailData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const active = useRef(false);

  const load = useCallback(async () => {
    if (!active.current) return;
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await api<ExpenseDetailData>(`/api/expenses/${expenseId}`);
      if (active.current && current === sequence.current) setDetail(next);
    } catch (cause) {
      if (!active.current || current !== sequence.current) return;
      if (cause instanceof RequestError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      // Do not leave stale actions enabled after a failed refresh.
      setDetail(null);
      setError(errorMessage(cause));
    } finally {
      if (active.current && current === sequence.current) setLoading(false);
    }
  }, [expenseId, onSessionExpired]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      sequence.current += 1;
    };
  }, [load, data]);

  if (detail)
    return (
      <ExpenseDetail
        expense={detail.expense}
        requests={detail.requests}
        data={data}
        reviewing={reviewing}
        onClose={onClose}
        onPay={onPay}
        onChanged={async () => {
          // A committed action refreshes the dashboard; its new snapshot reloads this panel.
          if (active.current) await onChanged();
        }}
      />
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={error ? 'Let’s try that again.' : 'The whole picture.'}
      description={error || 'Getting this shared moment ready…'}
    >
      {loading ? (
        <div className="loading-flower" role="status" aria-label="Loading expense">
          <Flower />
        </div>
      ) : (
        <Button fullWidth onClick={() => void load()}>
          Try again
        </Button>
      )}
    </Dialog>
  );
}
