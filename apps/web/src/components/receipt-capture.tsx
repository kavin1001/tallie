'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Camera,
  Check,
  FileCheck2,
  LockKeyhole,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { formatDecimalUsd, parseUsd } from '@tallie/domain';
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_MAX_LINES,
  type ReceiptDraft,
  type ReceiptProposal,
  type ReceiptUpload,
} from '@tallie/receipts/contracts';
import { containsSensitiveText } from '@tallie/receipts/validation';
import { api, errorMessage, money, RequestError } from '@/lib/client';
import { Button } from './ui';

export interface ReviewedReceipt {
  title: string;
  total: string;
  items: { id: string; name: string; amount: string }[];
  tax: string;
  tip: string;
  discount: string;
}

function decimal(value: string | null): string {
  return value === null ? '' : formatDecimalUsd(BigInt(value));
}

/** A proposal is a draft. Only the explicitly reviewed values enter the split composer. */
export function ReceiptCapture({
  onApply,
  onActiveChange,
  endpoint = '/api/receipts',
  initialReceiptId,
}: {
  onApply: (receipt: ReviewedReceipt) => void;
  onActiveChange: (active: boolean) => void;
  endpoint?: string | undefined;
  initialReceiptId?: string | undefined;
}) {
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ key: string; payload: ReceiptUpload } | null>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const onActive = useRef(onActiveChange);
  onActive.current = onActiveChange;

  useEffect(() => {
    if (!initialReceiptId) return;
    const abort = new AbortController();
    onActive.current(true);
    setUploading(true);
    void api<ReceiptDraft>(`${endpoint}/${initialReceiptId}`, undefined, undefined, abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setDraft(next);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(errorMessage(e));
          onActive.current(false);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setUploading(false);
      });
    return () => abort.abort();
  }, [initialReceiptId, endpoint]);

  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!draft || !['queued', 'processing'].includes(draft.status)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      try {
        const next = await api<ReceiptDraft>(
          `${endpoint}/${draft!.id}`,
          undefined,
          undefined,
          abort.signal,
        );
        if (stopped) return;
        setDraft(next);
        setError('');
        if (['queued', 'processing'].includes(next.status)) timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    }
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [draft?.id, draft?.status, pollAttempt, endpoint]);

  async function upload(file?: File) {
    if (inFlight.current) return;
    inFlight.current = true;
    const sequence = ++generation.current;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setError('');
    setUploading(true);
    try {
      if (file) {
        if (file.size === 0 || file.size > RECEIPT_MAX_BYTES)
          throw new Error('Choose a photo under 8 MB.');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
          throw new Error('Choose a JPG, PNG, or WebP photo. For HEIC, export it as a JPG first.');
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(new Error('That photo couldn’t be opened. Try again.'));
          reader.readAsDataURL(file);
        });
        if (sequence !== generation.current) return;
        attempt.current = {
          key: crypto.randomUUID(),
          payload: { contentBase64, contentType: file.type as ReceiptUpload['contentType'] },
        };
      }
      if (!attempt.current) return;
      onActiveChange(true);
      const next = await api<ReceiptDraft>(
        endpoint,
        attempt.current.payload,
        attempt.current.key,
        abort.signal,
      );
      if (sequence !== generation.current) return;
      attempt.current = null;
      setDraft(next);
      setApplied(false);
    } catch (e) {
      if (sequence !== generation.current) return;
      if (e instanceof RequestError && e.status >= 400 && e.status < 500) {
        attempt.current = null;
        if (!draft) onActiveChange(false);
      }
      setError(errorMessage(e));
    } finally {
      if (sequence === generation.current) {
        setUploading(false);
        inFlight.current = false;
      }
    }
  }

  function reset() {
    generation.current++;
    controller.current?.abort();
    attempt.current = null;
    inFlight.current = false;
    setDraft(null);
    setUploading(false);
    setApplied(false);
    setError('');
    onActiveChange(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function trySample() {
    if (loadingSample || inFlight.current) return;
    setLoadingSample(true);
    setError('');
    const sequence = generation.current;
    try {
      const response = await fetch('/sample-receipt.png');
      if (!response.ok) throw new Error('The sample photo couldn’t be loaded.');
      const blob = await response.blob();
      if (sequence !== generation.current) return;
      await upload(new File([blob], 'sample-receipt.png', { type: 'image/png' }));
    } catch (e) {
      if (sequence === generation.current) setError(errorMessage(e));
    } finally {
      setLoadingSample(false);
    }
  }

  if (draft?.status === 'review_needed' && draft.proposal && !applied)
    return (
      <ReceiptReview
        draft={draft}
        proposal={draft.proposal}
        onCancel={reset}
        onApply={(value) => {
          onApply(value);
          setApplied(true);
          onActiveChange(false);
        }}
      />
    );

  const pending = uploading || Boolean(draft && ['queued', 'processing'].includes(draft.status));
  return (
    <section className="receipt-capture" aria-label="Receipt capture" aria-busy={pending}>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        tabIndex={-1}
        aria-label="Receipt photo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {pending ? (
        <div className="receipt-working" role="status">
          <span className="capture-icon">
            <span className="ui-spinner" />
          </span>
          <div>
            <strong>{uploading ? 'One little upload…' : 'Finding the little details…'}</strong>
            <p>
              {uploading
                ? 'Your photo is on its way.'
                : 'We’re reading the receipt. You’ll check the amounts next.'}
            </p>
          </div>
        </div>
      ) : applied ? (
        <div className="receipt-working receipt-applied" role="status">
          <span className="capture-icon">
            <FileCheck2 size={23} />
          </span>
          <div>
            <strong>Receipt checked. Math ready.</strong>
            <p>Choose your friends, then pick how to split it.</p>
          </div>
        </div>
      ) : draft?.status === 'failed' ? (
        <div className="receipt-working">
          <span className="capture-icon">
            <Camera size={23} />
          </span>
          <div>
            <strong>Let’s give that another look.</strong>
            <p>{draft.error?.message ?? 'Try a clearer photo or enter the details below.'}</p>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="receipt-upload-button"
          disabled={Boolean(attempt.current) || loadingSample}
          onClick={() => fileInput.current?.click()}
        >
          <span className="capture-icon">
            <Camera size={23} strokeWidth={1.6} />
          </span>
          <div>
            <strong>A photo. A little less math.</strong>
            <span>Add a receipt · JPG, PNG, or WebP · up to 8 MB</span>
          </div>
          <Plus size={19} />
        </button>
      )}
      <p className="receipt-privacy">
        <LockKeyhole size={12} />
        {applied
          ? 'Your photo stays private. Friends only see the split.'
          : 'Processed with OpenAI. Only you can see the photo.'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="receipt-inline-actions">
        {!draft && !attempt.current && !uploading && (
          <button
            type="button"
            className="text-action"
            disabled={loadingSample}
            onClick={() => void trySample()}
          >
            {loadingSample ? 'Opening our sample…' : 'Try a sample photo'}
          </button>
        )}
        {attempt.current && !uploading && (
          <Button variant="secondary" size="sm" onClick={() => void upload()}>
            Retry this upload
          </Button>
        )}
        {error && pending && !uploading && (
          <Button variant="secondary" size="sm" onClick={() => setPollAttempt((n) => n + 1)}>
            Check again
          </Button>
        )}
        {(draft || attempt.current) && (
          <button type="button" className="text-action" onClick={reset}>
            {applied ? 'Read another receipt' : 'Enter details myself'}
          </button>
        )}
      </div>
    </section>
  );
}

function ReceiptReview({
  draft,
  proposal,
  onApply,
  onCancel,
}: {
  draft: ReceiptDraft;
  proposal: ReceiptProposal;
  onApply: (value: ReviewedReceipt) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [items, setItems] = useState(
    proposal.items.map((item) => ({
      id: item.id,
      name: item.description,
      amount: decimal(item.amountMinor),
    })),
  );
  const [total, setTotal] = useState(decimal(proposal.totalMinor));
  const [adjustments, setAdjustments] = useState({
    tax: decimal(proposal.taxMinor),
    tip: decimal(proposal.tipMinor),
    discount: decimal(proposal.discountMinor),
    service: decimal(proposal.serviceChargeMinor),
  });
  const [usdConfirmed, setUsdConfirmed] = useState(proposal.currency === 'USD');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const review = useMemo(() => {
    try {
      if (
        !total ||
        items.length === 0 ||
        items.some((item) => !item.amount) ||
        Object.values(adjustments).some((v) => !v)
      )
        return {
          ready: false,
          message: 'Fill in the blank amounts. Enter 0 where there is no charge.',
        };
      const sum =
        items.reduce((value, item) => value + parseUsd(item.amount), 0n) +
        parseUsd(adjustments.tax) +
        parseUsd(adjustments.tip) +
        parseUsd(adjustments.service) -
        parseUsd(adjustments.discount);
      const remaining = parseUsd(total) - sum;
      if (remaining !== 0n)
        return {
          ready: false,
          message: `${money(remaining < 0n ? -remaining : remaining)} ${remaining < 0n ? 'over' : 'still to account for'}. Check the items and adjustments.`,
        };
      if (sum <= 0n) return { ready: false, message: 'The total must be greater than $0.00.' };
      return { ready: true, message: 'Every cent accounted for.' };
    } catch {
      return { ready: false, message: 'Use dollar amounts with up to two decimal places.' };
    }
  }, [items, adjustments, total]);

  function apply() {
    if (!review.ready || !usdConfirmed || !checked) return;
    if (!title.trim() || items.some((item) => !item.name.trim())) {
      setError('Give the receipt and each item a name.');
      return;
    }
    if ([title, ...items.map((item) => item.name)].some(containsSensitiveText)) {
      setError(
        'Remove personal details, such as phone numbers and card details, from the names before sharing.',
      );
      return;
    }
    const lines = items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      name: item.name.trim(),
    }));
    if (parseUsd(adjustments.service) > 0n)
      lines.push({ id: crypto.randomUUID(), name: 'Service charge', amount: adjustments.service });
    if (lines.length > RECEIPT_MAX_LINES) {
      setError('Use at most 100 lines, including the service charge.');
      return;
    }
    onApply({
      title: title.trim(),
      total,
      items: lines,
      tax: adjustments.tax,
      tip: adjustments.tip,
      discount: adjustments.discount,
    });
  }

  return (
    <section className="receipt-review" aria-label="Review receipt">
      <div className="receipt-review-heading">
        <span className="capture-icon">
          <Sparkles size={22} strokeWidth={1.5} />
        </span>
        <div>
          <h3>A second pair of eyes.</h3>
          <p>We read it. You have the final say.</p>
        </div>
      </div>
      {draft.imageUrl && (
        <details className="receipt-photo">
          <summary>
            Take a look at your photo <span>Only you</span>
          </summary>
          <img
            src={draft.imageUrl}
            alt="Your private uploaded receipt for checking the extracted amounts"
          />
        </details>
      )}
      {proposal.warnings.length > 0 && (
        <div className="receipt-cautions">
          <strong>A few things to check</strong>
          <ul>
            {proposal.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-field">
        <label htmlFor="receipt-name">Receipt name</label>
        <input
          id="receipt-name"
          value={title}
          maxLength={100}
          onChange={(e) => {
            setTitle(e.target.value);
            setChecked(false);
          }}
        />
      </div>
      <div className="receipt-lines">
        <div className="receipt-column-heading">
          <span>WHAT’S ON THE RECEIPT</span>
          <span>LINE TOTAL</span>
        </div>
        {items.map((item, index) => (
          <div className="receipt-line" key={item.id}>
            <input
              aria-label={`Receipt item ${index + 1} name`}
              maxLength={100}
              value={item.name}
              onChange={(e) => {
                setItems((current) =>
                  current.map((row) =>
                    row.id === item.id ? { ...row, name: e.target.value } : row,
                  ),
                );
                setChecked(false);
              }}
            />
            <div className="small-money">
              <span>$</span>
              <input
                aria-label={`Receipt item ${index + 1} line total`}
                inputMode="decimal"
                placeholder="Check"
                value={item.amount}
                onChange={(e) => {
                  setItems((current) =>
                    current.map((row) =>
                      row.id === item.id ? { ...row, amount: e.target.value } : row,
                    ),
                  );
                  setChecked(false);
                }}
              />
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove receipt item ${index + 1}`}
              onClick={() => {
                setItems((current) => current.filter((row) => row.id !== item.id));
                setChecked(false);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="add-item"
          disabled={items.length >= RECEIPT_MAX_LINES}
          onClick={() => {
            setItems((current) => [...current, { id: crypto.randomUUID(), name: '', amount: '' }]);
            setChecked(false);
          }}
        >
          <Plus size={14} />
          Add a missed item
        </button>
      </div>
      <div className="receipt-adjustments">
        {(
          [
            ['tax', 'Tax'],
            ['tip', 'Tip'],
            ['discount', 'Discount (subtract)'],
            ['service', 'Service charge'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <div className="small-money">
              <span>$</span>
              <input
                inputMode="decimal"
                aria-label={`Receipt ${key}`}
                placeholder="Check"
                value={adjustments[key]}
                onChange={(e) => {
                  setAdjustments((current) => ({ ...current, [key]: e.target.value }));
                  setChecked(false);
                }}
              />
            </div>
          </label>
        ))}
      </div>
      {Object.values(adjustments).some((v) => !v) && (
        <button
          type="button"
          className="text-action"
          onClick={() => {
            setAdjustments(
              (current) =>
                Object.fromEntries(
                  Object.entries(current).map(([key, value]) => [key, value || '0.00']),
                ) as typeof current,
            );
            setChecked(false);
          }}
        >
          I checked — all blank adjustments are $0
        </button>
      )}
      <label className="receipt-total">
        Final total{' '}
        <div className="small-money">
          <span>$</span>
          <input
            aria-label="Receipt final total"
            inputMode="decimal"
            value={total}
            placeholder="Check"
            onChange={(e) => {
              setTotal(e.target.value);
              setChecked(false);
            }}
          />
        </div>
      </label>
      <p className={`receipt-reconciliation ${review.ready ? 'ready' : ''}`} role="status">
        {review.ready && <Check size={15} />}
        {review.message}
      </p>
      {/^\d+(\.\d{1,2})?$/.test(adjustments.service) && Number(adjustments.service) > 0 && (
        <p className="fine-print">
          A service charge becomes a shared item. You can choose who shares it in the next step.
        </p>
      )}
      {proposal.currency !== 'USD' && (
        <label className="receipt-confirm">
          <input
            type="checkbox"
            checked={usdConfirmed}
            onChange={(e) => setUsdConfirmed(e.target.checked)}
          />
          <span>
            I checked the original receipt: these amounts are in USD. Tallie does not convert
            currencies.
          </span>
        </label>
      )}
      <label className="receipt-confirm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>I checked the amounts and removed personal details from the names.</span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button fullWidth disabled={!review.ready || !usdConfirmed || !checked} onClick={apply}>
        Use these details <ArrowRight size={16} />
      </Button>
      <div className="receipt-review-footer">
        <p className="receipt-privacy">
          <LockKeyhole size={12} />
          Your photo stays private.
        </p>
        <button type="button" className="text-action" onClick={onCancel}>
          Enter it myself
        </button>
      </div>
    </section>
  );
}
