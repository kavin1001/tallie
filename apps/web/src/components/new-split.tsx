'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Equal,
  ListFilter,
  Plus,
  Receipt,
  SlidersHorizontal,
  Trash2,
  Utensils,
} from 'lucide-react';
import {
  allocateByItem,
  allocateCustom,
  allocateEqual,
  formatDecimalUsd,
  parseUsd,
  type Allocation,
} from '@tallie/domain';
import type {
  Category,
  CreateExpenseInput,
  Dashboard,
  ExpenseSummary,
  SplitMethod,
} from '@tallie/db/contracts';
import { Avatar, Button, Dialog } from './ui';
import { api, cents, errorMessage, money, RequestError } from '@/lib/client';
import { ReceiptCapture, type ReviewedReceipt } from './receipt-capture';

interface DraftItem {
  id: string;
  name: string;
  amount: string;
  participantIds: string[];
}
export function NewSplit({
  data,
  onClose,
  onCreated,
  onSubmit,
  receiptEndpoint,
  showExample = true,
  initialReceiptId,
  initialDraft,
}: {
  data: Pick<Dashboard, 'user' | 'people' | 'capabilities'>;
  onClose: () => void;
  onCreated?: (expense: ExpenseSummary) => Promise<void>;
  onSubmit?: (input: CreateExpenseInput, key: string) => Promise<void>;
  receiptEndpoint?: string;
  showExample?: boolean;
  initialReceiptId?: string;
  initialDraft?: { title: string; totalMinor: string | null; participantIds: string[] };
}) {
  const [step, setStep] = useState<'details' | 'method'>('details');
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [category, setCategory] = useState<Category>('dinner');
  const titleInput = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(
    initialDraft?.totalMinor ? formatDecimalUsd(BigInt(initialDraft.totalMinor)) : '',
  );
  const [selected, setSelected] = useState<string[]>(() => [
    ...new Set([
      data.user.id,
      ...(initialDraft?.participantIds ?? []).filter((id) =>
        data.people.some((person) => person.id === id),
      ),
    ]),
  ]);
  const [method, setMethod] = useState<SplitMethod | null>(null);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [items, setItems] = useState<DraftItem[]>([]);
  const [tax, setTax] = useState('0');
  const [tip, setTip] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [receiptActive, setReceiptActive] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ key: string; payload: CreateExpenseInput } | null>(null);
  const submitLock = useRef(false);
  const participants = data.people.filter((person) => selected.includes(person.id));
  const preview = useMemo((): { allocations: readonly Allocation[]; error: string } => {
    try {
      const total = parseUsd(amount);
      if (total === 0n || selected.length < 2 || !method) return { allocations: [], error: '' };
      if (method === 'equal') return { allocations: allocateEqual(total, selected), error: '' };
      if (method === 'custom')
        return {
          allocations: allocateCustom(
            total,
            selected.map((participantId) => ({
              participantId,
              amountMinor: parseUsd(custom[participantId] ?? '0'),
            })),
          ),
          error: '',
        };
      return {
        allocations: allocateByItem({
          participantIds: selected,
          items: items.map((item) => ({
            id: item.id,
            totalMinor: parseUsd(item.amount),
            participantIds: item.participantIds,
          })),
          taxMinor: parseUsd(tax),
          tipMinor: parseUsd(tip),
          discountMinor: parseUsd(discount),
          statedTotalMinor: total,
        }).allocations,
        error: '',
      };
    } catch (e) {
      return { allocations: [], error: errorMessage(e) };
    }
  }, [amount, selected, method, custom, items, tax, tip, discount]);

  function togglePerson(id: string) {
    if (id === data.user.id) return;
    const next = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id];
    setItems((current) =>
      current.map((item) => ({
        ...item,
        participantIds: selected.every((personId) => item.participantIds.includes(personId))
          ? next
          : item.participantIds.filter((personId) => next.includes(personId)),
      })),
    );
    setSelected(next);
    setMethod(null);
    setCustom({});
  }
  function applyReceipt(receipt: ReviewedReceipt) {
    setTitle(receipt.title);
    setAmount(receipt.total);
    setItems(receipt.items.map((item) => ({ ...item, participantIds: selected })));
    setTax(receipt.tax);
    setTip(receipt.tip);
    setDiscount(receipt.discount);
    setMethod(null);
    setCustom({});
    setError('');
  }
  function useExample() {
    const maya =
      data.people.find((p) => p.firstName === 'Maya' && p.id !== data.user.id) ??
      data.people.find((p) => p.id !== data.user.id);
    const leo =
      data.people.find(
        (p) => p.firstName === 'Leo' && p.id !== data.user.id && p.id !== maya?.id,
      ) ?? data.people.find((p) => p.id !== data.user.id && p.id !== maya?.id);
    if (!maya || !leo) return;
    const ids = [data.user.id, maya.id, leo.id];
    setTitle('Dinner at Lilia');
    setCategory('dinner');
    setAmount('117.00');
    setSelected(ids);
    setTax('9.00');
    setTip('18.00');
    setDiscount('0');
    setItems([
      {
        id: crypto.randomUUID(),
        name: 'Pasta & plates to share',
        amount: '60.00',
        participantIds: ids,
      },
      {
        id: crypto.randomUUID(),
        name: 'A little wine',
        amount: '30.00',
        participantIds: [data.user.id, leo.id],
      },
    ]);
    setMethod(null);
    setError('');
    setStep('method');
  }
  function next() {
    if (receiptActive) return;
    try {
      if (!title.trim()) throw new Error('Give this moment a name.');
      if (parseUsd(amount) <= 0n) throw new Error('Enter a total greater than $0.00.');
      if (selected.length < 2) throw new Error('Choose at least one friend to share with.');
      setError('');
      setStep('method');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function chooseMethod(nextMethod: SplitMethod) {
    setMethod(nextMethod);
    setError('');
    if (nextMethod === 'custom' && Object.keys(custom).length === 0) {
      setCustom(
        Object.fromEntries(
          allocateEqual(parseUsd(amount), selected).map((share) => [
            share.participantId,
            formatDecimalUsd(share.amountMinor),
          ]),
        ),
      );
    }
    if (nextMethod === 'items' && items.length === 0)
      setItems([
        {
          id: crypto.randomUUID(),
          name: 'Shared item',
          amount: formatDecimalUsd(parseUsd(amount)),
          participantIds: selected,
        },
      ]);
  }
  function updateItem(id: string, update: Partial<DraftItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...update } : item)));
  }
  async function submit() {
    if (submitLock.current || !method) return;
    submitLock.current = true;
    setBusy(true);
    setError('');
    try {
      if (!attempt.current) {
        if (preview.error || preview.allocations.length === 0)
          throw new Error(preview.error || 'Complete everyone’s share first.');
        const payload: CreateExpenseInput = {
          title: title.trim(),
          emoji: {
            dinner: '🍽️',
            travel: '✈️',
            coffee: '☕',
            groceries: '🥑',
            tickets: '🎟️',
            other: '✨',
          }[category],
          category,
          totalMinor: cents(amount),
          participantIds: selected,
          method,
        };
        if (method === 'custom')
          payload.shares = selected.map((participantId) => ({
            participantId,
            amountMinor: cents(custom[participantId] ?? '0'),
          }));
        if (method === 'items') {
          payload.items = items.map((item) => ({
            id: item.id,
            name: item.name.trim() || 'Shared item',
            amountMinor: cents(item.amount),
            participantIds: item.participantIds,
          }));
          payload.taxMinor = cents(tax);
          payload.tipMinor = cents(tip);
          payload.discountMinor = cents(discount);
        }
        attempt.current = { key: crypto.randomUUID(), payload };
      }
      if (onSubmit) await onSubmit(attempt.current.payload, attempt.current.key);
      else {
        const expense = await api<ExpenseSummary>(
          '/api/expenses',
          attempt.current.payload,
          attempt.current.key,
        );
        await onCreated?.(expense);
      }
    } catch (e) {
      if (e instanceof RequestError && e.status >= 400 && e.status < 500) {
        attempt.current = null;
        setUncertain(false);
        setError(errorMessage(e));
      } else if (attempt.current) {
        setUncertain(true);
        setError(
          'We couldn’t confirm the result. Retry safely below; Tallie will reuse this exact request.',
        );
      } else setError(errorMessage(e));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  const totalRequests = preview.allocations.filter(
    (p) => p.participantId !== data.user.id && p.amountMinor > 0n,
  ).length;
  return (
    <Dialog
      open
      initialFocusRef={titleInput}
      onClose={() => {
        if (!busy && !uncertain) onClose();
      }}
      title={step === 'details' ? 'A good time, shared.' : 'How shall we split it?'}
      description={
        step === 'details'
          ? 'You took care of the moment. Let’s take care of the math.'
          : 'A fair share looks different every time. You choose.'
      }
      size="lg"
      footer={
        <>
          <div className="composer-footer-note">
            <span className="step-indicator">
              {step === 'details' ? '1' : '2'}
              <span>/ 2</span>
            </span>
            <span>{step === 'details' ? 'The moment' : 'The shares'}</span>
          </div>
          {step === 'details' ? (
            <Button onClick={next} disabled={receiptActive}>
              Choose the split <ArrowRight size={16} />
            </Button>
          ) : (
            <Button
              onClick={submit}
              loading={busy}
              disabled={!uncertain && (Boolean(preview.error) || preview.allocations.length === 0)}
            >
              {uncertain
                ? 'Retry safely'
                : `Send ${totalRequests} ${totalRequests === 1 ? 'request' : 'requests'}`}
              <ArrowRight size={16} />
            </Button>
          )}
        </>
      }
    >
      <fieldset disabled={busy || uncertain} className="composer-fields">
        {step === 'details' ? (
          <>
            {data.capabilities.receiptUpload && (
              <ReceiptCapture
                onApply={applyReceipt}
                onActiveChange={setReceiptActive}
                endpoint={receiptEndpoint}
                initialReceiptId={initialReceiptId}
              />
            )}
            {!receiptActive && showExample && (
              <button className="sample-receipt" type="button" onClick={useExample}>
                <span className="sample-icon">
                  <Receipt size={23} />
                </span>
                <div>
                  <strong>Start with a little inspiration</strong>
                  <span>Try our $117 dinner receipt</span>
                </div>
                <ArrowUpRightIcon />
              </button>
            )}
            {!receiptActive && (
              <>
                <div className="form-field">
                  <label htmlFor="split-title">What’s the occasion?</label>
                  <input
                    ref={titleInput}
                    id="split-title"
                    maxLength={100}
                    placeholder="Dinner, a weekend away…"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="form-field category-field">
                  <label htmlFor="split-category">A little category</label>
                  <select
                    id="split-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value as Category)}
                  >
                    <option value="dinner">Dinner & drinks</option>
                    <option value="coffee">Coffee & little treats</option>
                    <option value="travel">Trips & adventures</option>
                    <option value="groceries">Groceries & everyday things</option>
                    <option value="tickets">Tickets & good times</option>
                    <option value="other">Something else</option>
                  </select>
                </div>
                <div className="amount-field">
                  <label htmlFor="split-amount">How much did you cover?</label>
                  <div>
                    <span>$</span>
                    <input
                      id="split-amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-describedby="amount-hint"
                    />
                    <small>USD</small>
                  </div>
                  <p id="amount-hint">The full amount, including tax and tip.</p>
                </div>
                <div className="form-field">
                  <span className="field-label">Who was there?</span>
                  <div className="people-picker">
                    {data.people.map((person) => (
                      <button
                        key={person.id}
                        type="button"
                        className={selected.includes(person.id) ? 'selected' : ''}
                        aria-pressed={selected.includes(person.id)}
                        onClick={() => togglePerson(person.id)}
                        disabled={person.id === data.user.id}
                      >
                        <Avatar name={person.name} size="sm" />
                        <span>{person.id === data.user.id ? 'You' : person.firstName}</span>
                        {selected.includes(person.id) && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="composer-caption">
                  You’re the original payer. Everyone gets their own request.
                </p>
              </>
            )}
          </>
        ) : (
          <>
            <div className="split-context">
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setStep('details');
                  setError('');
                }}
                aria-label="Back to expense details"
              >
                <ArrowLeft size={18} />
              </button>
              <span>
                <strong>{title}</strong>
                <small>{selected.length} people · You paid</small>
              </span>
              <b>{money(cents(amount))}</b>
            </div>
            <div className="method-picker" aria-label="Choose a split method">
              {(
                [
                  {
                    id: 'equal',
                    title: 'Equally',
                    description: 'Same share for everyone',
                    icon: Equal,
                  },
                  {
                    id: 'items',
                    title: 'By item',
                    description: 'Only what you had',
                    icon: ListFilter,
                  },
                  {
                    id: 'custom',
                    title: 'Custom',
                    description: 'You know what’s fair',
                    icon: SlidersHorizontal,
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={method === option.id}
                  className={method === option.id ? 'selected' : ''}
                  onClick={() => chooseMethod(option.id)}
                >
                  <option.icon size={22} strokeWidth={1.6} />
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                  {method === option.id && <Check className="method-check" size={14} />}
                </button>
              ))}
            </div>
            {!method && (
              <div className="method-invitation">
                <Utensils size={23} strokeWidth={1.3} />
                <p>
                  Everybody’s different.
                  <br />
                  Pick the split that feels right.
                </p>
              </div>
            )}
            {method === 'items' && (
              <div className="item-editor">
                {items.map((item, index) => (
                  <div className="item-edit" key={item.id}>
                    <div className="item-input-row">
                      <input
                        aria-label={`Item ${index + 1} name`}
                        value={item.name}
                        maxLength={100}
                        onChange={(e) => updateItem(item.id, { name: e.target.value })}
                      />
                      <div className="small-money">
                        <span>$</span>
                        <input
                          aria-label={`Item ${index + 1} amount`}
                          inputMode="decimal"
                          value={item.amount}
                          onChange={(e) => updateItem(item.id, { amount: e.target.value })}
                        />
                      </div>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Remove item ${index + 1}`}
                        disabled={items.length <= 1}
                        onClick={() =>
                          setItems((current) => current.filter((row) => row.id !== item.id))
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="item-assignees">
                      {participants.map((person) => (
                        <button
                          key={person.id}
                          type="button"
                          aria-pressed={item.participantIds.includes(person.id)}
                          className={item.participantIds.includes(person.id) ? 'selected' : ''}
                          onClick={() =>
                            updateItem(item.id, {
                              participantIds: item.participantIds.includes(person.id)
                                ? item.participantIds.filter((id) => id !== person.id)
                                : [...item.participantIds, person.id],
                            })
                          }
                        >
                          {item.participantIds.includes(person.id) && <Check size={11} />}{' '}
                          {person.id === data.user.id ? 'You' : person.firstName}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  className="add-item"
                  type="button"
                  onClick={() =>
                    setItems((current) => [
                      ...current,
                      { id: crypto.randomUUID(), name: '', amount: '0', participantIds: selected },
                    ])
                  }
                >
                  <Plus size={15} />
                  Add an item
                </button>
                <div className="adjustments">
                  <label>
                    Tax
                    <div className="small-money">
                      <span>$</span>
                      <input
                        inputMode="decimal"
                        value={tax}
                        onChange={(e) => setTax(e.target.value)}
                      />
                    </div>
                  </label>
                  <label>
                    Tip
                    <div className="small-money">
                      <span>$</span>
                      <input
                        inputMode="decimal"
                        value={tip}
                        onChange={(e) => setTip(e.target.value)}
                      />
                    </div>
                  </label>
                  <label>
                    Discount
                    <div className="small-money">
                      <span>−$</span>
                      <input
                        inputMode="decimal"
                        value={discount}
                        onChange={(e) => setDiscount(e.target.value)}
                      />
                    </div>
                  </label>
                </div>
                <p className="fine-print">
                  Tax, tip, and discounts are shared proportionally to each person’s items. Items +
                  tax + tip − discount must match the total.
                </p>
              </div>
            )}
            {method && (
              <section className="share-preview">
                <div className="preview-heading">
                  <span>EVERYONE’S SHARE</span>
                  {!preview.error && (
                    <span>
                      <CheckCheck size={14} />
                      Every cent accounted for
                    </span>
                  )}
                </div>
                {participants.map((person) => {
                  const allocation = preview.allocations.find((a) => a.participantId === person.id);
                  return (
                    <div key={person.id} className="share-row">
                      <Avatar name={person.name} size="sm" />
                      <div>
                        <strong>{person.id === data.user.id ? 'You' : person.firstName}</strong>
                        {person.id === data.user.id && <small>Already covered</small>}
                      </div>
                      {method === 'custom' ? (
                        <div className="small-money">
                          <span>$</span>
                          <input
                            inputMode="decimal"
                            aria-label={`${person.firstName}’s share`}
                            value={custom[person.id] ?? ''}
                            onChange={(e) =>
                              setCustom((current) => ({ ...current, [person.id]: e.target.value }))
                            }
                          />
                        </div>
                      ) : (
                        <b>{allocation ? money(allocation.amountMinor) : '—'}</b>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
            {preview.error && (
              <p className="form-hint" role="status">
                {preview.error}
              </p>
            )}
            {method && (
              <p className="composer-caption">
                Everyone can see the full breakdown. Each friend approves their own payment.
              </p>
            )}
          </>
        )}
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
function ArrowUpRightIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}
