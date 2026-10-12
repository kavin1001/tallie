'use client';
import { useAccountApi } from './account-context';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  History,
  Home,
  MessageCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { MessageDraft } from '@tallie/messaging/contracts';
import type { IdentityAccount } from '@tallie/identity/contracts';
import type { Person } from '@tallie/db/contracts';
import type { SocialContact, SocialDashboard, SocialExpense } from '@tallie/social/contracts';
import { errorMessage, money, RequestError, shortDate } from '@/lib/client';
import { Avatar, Button, Dialog } from './ui';
import { Flower, Wordmark } from './brand';
import { NewSplit } from './new-split';
import { AddFriend, InvitationSheet, type InviteContext } from './account/friends';
import { AccountExpense } from './account/expense';
import { PaymentsSandbox } from './account/payments-sandbox';
import { PaymentsConnect } from './account/payments-connect';
import { OwnerPilot } from './account/owner-pilot';
import './account-home.css';

type Page = 'home' | 'people' | 'activity';
const toPerson = (id: string, name: string): Person => ({
  id,
  name,
  firstName: name.split(' ')[0] ?? name,
  initials: name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join(''),
  color: 'sage',
  venmoHandle: null,
});

export function AccountHome({
  account,
  onSignOut,
  onSecurity,
  onMessages,
  messagingAvailable = false,
  sandboxPaymentsAvailable = false,
  productionConnectionAvailable = false,
  ownerPilotAvailable = false,
  paymentReturnState,
  initialExpenseId,
  initialReceiptId,
  initialMessageDraft,
}: {
  account: IdentityAccount;
  onSignOut: () => void | Promise<void>;
  onSecurity: () => void;
  onMessages: () => void;
  messagingAvailable?: boolean;
  sandboxPaymentsAvailable?: boolean;
  productionConnectionAvailable?: boolean;
  ownerPilotAvailable?: boolean;
  paymentReturnState?: string;
  initialExpenseId?: string;
  initialReceiptId?: string;
  initialMessageDraft?: MessageDraft;
}) {
  const api = useAccountApi();
  const [data, setData] = useState<SocialDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>('home');
  const [addOpen, setAddOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(Boolean(initialReceiptId));
  const [activeReceiptId, setActiveReceiptId] = useState(initialReceiptId);
  const [activeMessageDraft, setActiveMessageDraft] = useState<MessageDraft | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [expenseId, setExpenseId] = useState<string | null>(initialExpenseId ?? null);
  const [invite, setInvite] = useState<InviteContext | null>(null);
  const [search, setSearch] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const invitationKeys = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await api<SocialDashboard>('/api/social/dashboard');
      if (!mounted.current || current !== sequence.current) return;
      if (next.userId !== account.id)
        throw new Error('Your account changed in another tab. Refresh Tallie before continuing.');
      setData(next);
      setError('');
    } catch (cause) {
      if (mounted.current && current === sequence.current) {
        if (cause instanceof RequestError && cause.status === 401) setData(null);
        setError(errorMessage(cause));
      }
      throw cause;
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, [account, api]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => undefined);
    const focus = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      sequence.current++;
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  useEffect(() => {
    if (initialExpenseId) setExpenseId(initialExpenseId);
  }, [initialExpenseId]);
  useEffect(() => {
    if (initialReceiptId) {
      setActiveReceiptId(initialReceiptId);
      setSplitOpen(true);
    }
  }, [initialReceiptId]);
  useEffect(() => {
    if (!initialMessageDraft) return;
    setActiveMessageDraft(initialMessageDraft);
    setActiveReceiptId(initialMessageDraft.receiptId ?? undefined);
    setSplitOpen(true);
  }, [initialMessageDraft]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const composer = useMemo(() => {
    const user = toPerson(account.id, account.name);
    return {
      user,
      people: [
        user,
        ...(data?.contacts ?? []).map((contact) => toPerson(contact.id, contact.label)),
      ],
      capabilities: {
        natural: false as const,
        imessage: false as const,
        venmo: false as const,
        receiptUpload: data?.capabilities.receiptUpload ?? false,
      },
    };
  }, [account, data]);
  const hasTestSplits = Boolean(
    data?.expenses.some((expense) => expense.paymentEnvironment === 'sandbox'),
  );
  useEffect(() => {
    if (!hasTestSplits) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [hasTestSplits, refresh]);
  const filteredContacts = (data?.contacts ?? []).filter((contact) =>
    `${contact.label} ${contact.maskedPhone}`.toLowerCase().includes(search.toLowerCase()),
  );
  const firstName = account.name.split(' ')[0] ?? account.name;

  function inviteFriend(contact: SocialContact, targetExpenseId?: string) {
    const contextKey = `${contact.id}:${targetExpenseId ?? 'friend'}`;
    const key = invitationKeys.current.get(contextKey) ?? crypto.randomUUID();
    invitationKeys.current.set(contextKey, key);
    setInvite({ contact, ...(targetExpenseId ? { expenseId: targetExpenseId } : {}), key });
  }
  function beginSplit() {
    setActiveMessageDraft(null);
    setActiveReceiptId(undefined);
    if (!data?.contacts.length) setAddOpen(true);
    else setSplitOpen(true);
  }
  function changePage(next: Page) {
    setPage(next);
    setSearch('');
  }
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  return (
    <div className="account-home">
      <aside className="account-sidebar">
        <button
          className="account-brand"
          aria-label="Tallie home"
          onClick={() => changePage('home')}
        >
          <Wordmark />
        </button>
        <div className="account-early">
          <span /> A little early. A lot of possibility.
        </div>
        <nav aria-label="Main navigation" className="account-nav">
          {(
            [
              { id: 'home', label: 'Home', Icon: Home },
              { id: 'people', label: 'People', Icon: Users },
              { id: 'activity', label: 'Activity', Icon: History },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              className={page === id ? 'active' : ''}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => changePage(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === 'people' && Boolean(data?.contacts.length) && (
                <small>{data?.contacts.length}</small>
              )}
            </button>
          ))}
        </nav>
        {messagingAvailable && (
          <button className="account-message-card" onClick={onMessages}>
            <MessageCircle size={23} />
            <strong>A friend in Messages.</strong>
            <span>Make room for the good stuff.</span>
            <b>
              Connect Tallie <ArrowUpRight size={15} />
            </b>
          </button>
        )}
        <button className="account-profile" onClick={() => setProfileOpen(true)}>
          <Avatar name={account.name} />
          <span>
            <strong>{account.name}</strong>
            <small>Your account</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </aside>
      <div className="account-workspace">
        <header className="account-topbar">
          <span>Your little corner of Tallie.</span>
          <button
            className="account-mobile-brand"
            aria-label="Tallie home"
            onClick={() => changePage('home')}
          >
            <Wordmark />
          </button>
          <div>
            <span className="account-beta">PRIVATE BETA</span>
            <button
              aria-label="Your account"
              className="account-avatar-button"
              onClick={() => setProfileOpen(true)}
            >
              <Avatar name={account.name} size="sm" />
            </button>
          </div>
        </header>
        <main className="account-main">
          {error && (
            <div className="account-error" role="alert">
              <span>{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh().catch(() => undefined)}
              >
                Try again
              </Button>
            </div>
          )}
          {loading && !data ? (
            <div className="account-loading" role="status">
              <Flower />
              <p>Making yourself at home…</p>
            </div>
          ) : !data ? (
            <div className="account-empty">
              <ShieldCheck size={32} />
              <h2>Let’s get you back in.</h2>
              <p>Your account needs a fresh sign-in.</p>
              <Button onClick={() => void signOut()}>Back to sign in</Button>
            </div>
          ) : (
            <>
              <section className="account-heading">
                <div>
                  <p className="account-eyebrow">
                    {page === 'home'
                      ? 'GOOD COMPANY, ALL SQUARE'
                      : page === 'people'
                        ? 'THE PEOPLE MAKE IT'
                        : 'LIFE, WELL SHARED'}
                  </p>
                  <h1>
                    {page === 'home' ? (
                      <>
                        Hey, {firstName}
                        <span className="account-greeting-flower">✳</span>
                      </>
                    ) : page === 'people' ? (
                      <>
                        Your people<span className="account-title-dot">.</span>
                      </>
                    ) : (
                      <>
                        The little moments<span className="account-title-dot">.</span>
                      </>
                    )}
                  </h1>
                  <p>
                    {page === 'home'
                      ? 'A little less sorting out. A little more hanging out.'
                      : page === 'people'
                        ? 'Dinner regulars. Travel buddies. Your kind of company.'
                        : 'Everything you’ve shared, with the details in one place.'}
                  </p>
                </div>
                <Button
                  icon={<Plus size={18} />}
                  onClick={page === 'people' ? () => setAddOpen(true) : beginSplit}
                >
                  {page === 'people' ? 'Add a friend' : 'New split'}
                </Button>
              </section>
              {page === 'home' && (
                <>
                  <div className="account-balances">
                    <article>
                      <div>
                        <span>Coming your way</span>
                        <ArrowDownLeft size={20} />
                      </div>
                      <strong>{money(data.summary.owedToYouMinor)}</strong>
                      <p>Shared expenses you paid for</p>
                    </article>
                    <article>
                      <div>
                        <span>Your share to cover</span>
                        <ArrowUpRight size={20} />
                      </div>
                      <strong>{money(data.summary.owingMinor)}</strong>
                      <p>What you owe your friends</p>
                    </article>
                  </div>
                  <p className="account-payment-note">
                    <span aria-hidden="true">✳</span>{' '}
                    {ownerPilotAvailable
                      ? 'Splits are saved. The personal payment test is separate below.'
                      : 'Splits are saved. Payments are coming soon.'}
                  </p>
                  {data.capabilities.sandboxPayments && data.sandboxSummary && (
                    <div className="account-test-summary" aria-label="Test split balances">
                      <span className="account-test-badge">TEST SPLITS</span>
                      <p>
                        <strong>{money(data.sandboxSummary.owingMinor)}</strong> to try paying
                      </p>
                      <p>
                        <strong>{money(data.sandboxSummary.owedToYouMinor)}</strong> coming your way
                      </p>
                      <small>Test dollars · separate from your real shares</small>
                    </div>
                  )}
                  {sandboxPaymentsAvailable && <PaymentsSandbox />}
                  {ownerPilotAvailable && <OwnerPilot accountId={account.id} />}
                  {productionConnectionAvailable && (
                    <PaymentsConnect
                      onSecurity={onSecurity}
                      {...(paymentReturnState ? { returnState: paymentReturnState } : {})}
                    />
                  )}
                  <section className="account-section">
                    <div className="account-section-heading">
                      <h2>Recent moments</h2>
                      {data.expenses.length > 0 && (
                        <button className="text-action" onClick={() => changePage('activity')}>
                          See all
                        </button>
                      )}
                    </div>
                    {data.expenses.length ? (
                      <ExpenseList expenses={data.expenses.slice(0, 5)} onOpen={setExpenseId} />
                    ) : (
                      <div className="account-first-moment">
                        <div className="account-empty-art" aria-hidden="true">
                          <div className="account-paper">
                            <span>GOOD TIMES</span>
                            <Flower />
                            <i />
                            <i />
                            <b>Better together.</b>
                          </div>
                          <span className="account-art-star">✧</span>
                        </div>
                        <div>
                          <p className="account-eyebrow">YOUR FIRST OF MANY</p>
                          <h2>Start with a good moment.</h2>
                          <p>
                            A coffee run. A dinner that went long.
                            <br />
                            Add a friend and make your first split.
                          </p>
                          <Button
                            variant="secondary"
                            icon={<Plus size={16} />}
                            onClick={beginSplit}
                          >
                            {data.contacts.length
                              ? 'Split something good'
                              : 'Add your first friend'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </section>
                  {data.contacts.length > 0 && (
                    <section className="account-section">
                      <div className="account-section-heading">
                        <h2>Good company</h2>
                        <button className="text-action" onClick={() => changePage('people')}>
                          Your people
                        </button>
                      </div>
                      <div className="account-friend-strip">
                        {data.contacts.slice(0, 7).map((contact) => (
                          <button
                            key={contact.id}
                            onClick={() =>
                              contact.status === 'invitation_needed'
                                ? inviteFriend(contact)
                                : changePage('people')
                            }
                          >
                            <Avatar name={contact.label} size="lg" />
                            <strong>{contact.label.split(' ')[0]}</strong>
                            <span>
                              {contact.status === 'connected' ? 'Connected' : 'Invite a friend'}
                            </span>
                          </button>
                        ))}
                        <button onClick={() => setAddOpen(true)}>
                          <span className="account-add-avatar">
                            <Plus size={22} />
                          </span>
                          <strong>Add a friend</strong>
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )}
              {page === 'people' && (
                <section className="account-section">
                  <label className="account-search">
                    <span className="visually-hidden">Find a friend</span>
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Find a friend…"
                      type="search"
                    />
                  </label>
                  {filteredContacts.length ? (
                    <div className="account-contact-grid">
                      {filteredContacts.map((contact) => (
                        <article key={contact.id} className="account-contact">
                          <Avatar name={contact.label} size="lg" />
                          <div>
                            <h3>{contact.label}</h3>
                            <p>{contact.maskedPhone}</p>
                            <span
                              className={`account-contact-status ${contact.status === 'connected' ? 'connected' : ''}`}
                            >
                              {contact.status === 'connected'
                                ? 'Connected on Tallie'
                                : 'Ready for an invitation'}
                            </span>
                          </div>
                          {contact.status === 'invitation_needed' ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => inviteFriend(contact)}
                            >
                              Invite
                            </Button>
                          ) : (
                            <span className="account-connected-mark" aria-label="Connected">
                              ✓
                            </span>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="account-empty">
                      <Users size={32} />
                      <h2>{search ? 'No one by that name.' : 'Good company starts here.'}</h2>
                      <p>
                        {search
                          ? 'Try their name or the last four digits.'
                          : 'Add a friend by number. Only the person you invite can accept.'}
                      </p>
                      {!search && (
                        <Button onClick={() => setAddOpen(true)} icon={<Plus size={16} />}>
                          Add a friend
                        </Button>
                      )}
                    </div>
                  )}
                </section>
              )}
              {page === 'activity' && (
                <section className="account-section">
                  <div className="account-section-heading">
                    <h2>All your moments</h2>
                    <button
                      className="account-refresh"
                      aria-label="Refresh activity"
                      onClick={() => void refresh().catch(() => undefined)}
                    >
                      <RefreshCw size={17} />
                    </button>
                  </div>
                  {data.expenses.length ? (
                    <ExpenseList expenses={data.expenses} onOpen={setExpenseId} />
                  ) : (
                    <div className="account-empty">
                      <Flower />
                      <h2>Room for good memories.</h2>
                      <p>Your first shared expense will appear here.</p>
                      <Button onClick={beginSplit}>Make your first split</Button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {notice && (
        <div className="account-notice" role="status">
          ✓ {notice}
        </div>
      )}
      {addOpen && (
        <AddFriend
          onClose={() => setAddOpen(false)}
          onAdded={async (contact) => {
            setAddOpen(false);
            await refresh().catch(() => undefined);
            inviteFriend(contact);
          }}
        />
      )}
      {invite && (
        <InvitationSheet
          context={invite}
          onClose={() => setInvite(null)}
          onFreshKey={() => {
            const key = crypto.randomUUID();
            invitationKeys.current.set(`${invite.contact.id}:${invite.expenseId ?? 'friend'}`, key);
            setInvite({ ...invite, key });
          }}
          onCopied={() => setNotice('Invite link copied. A little good company, on its way.')}
        />
      )}
      {splitOpen && data && (
        <NewSplit
          key={activeMessageDraft?.id ?? activeReceiptId ?? 'new-split'}
          data={composer}
          {...(activeMessageDraft
            ? {
                initialDraft: {
                  title: activeMessageDraft.title,
                  totalMinor: activeMessageDraft.totalMinor,
                  participantIds: activeMessageDraft.participants.map((p) => p.personId),
                },
              }
            : {})}
          sandboxPaymentsAvailable={Boolean(
            data.capabilities.sandboxPayments && !activeMessageDraft,
          )}
          showExample={false}
          receiptEndpoint="/api/account-receipts"
          {...(activeReceiptId ? { initialReceiptId: activeReceiptId } : {})}
          onClose={() => {
            setSplitOpen(false);
            setActiveMessageDraft(null);
            setActiveReceiptId(undefined);
          }}
          onSubmit={async (input, key, paymentEnvironment) => {
            const expense = activeMessageDraft
              ? {
                  id: (
                    await api<{ expenseId: string }>(
                      `/api/messages/drafts/${activeMessageDraft.id}/publish`,
                      { version: activeMessageDraft.version, input },
                      key,
                    )
                  ).expenseId,
                }
              : await api<SocialExpense>(
                  '/api/social/expenses',
                  { ...input, paymentEnvironment },
                  key,
                );
            if (!mounted.current) return;
            setSplitOpen(false);
            setActiveMessageDraft(null);
            setActiveReceiptId(undefined);
            setExpenseId(expense.id);
            await refresh().catch(() => undefined);
            setNotice(
              paymentEnvironment === 'sandbox'
                ? 'Test split saved. A little practice, together.'
                : 'Split saved. Every little detail, sorted.',
            );
          }}
        />
      )}
      {expenseId && (
        <AccountExpense
          id={expenseId}
          contacts={data?.contacts ?? []}
          onClose={() => setExpenseId(null)}
          onInvite={inviteFriend}
          onUpdated={() => refresh().catch(() => undefined)}
        />
      )}
      <Dialog
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Your little corner."
        description="The details that make Tallie yours."
        size="sm"
      >
        <div className="account-settings-profile">
          <Avatar name={account.name} size="lg" />
          <div>
            <h3>{account.name}</h3>
            <p>{account.maskedPhone}</p>
          </div>
        </div>
        <div className="account-settings-list">
          <button
            onClick={() => {
              setProfileOpen(false);
              onSecurity();
            }}
          >
            <ShieldCheck size={19} />
            <span>
              Sign-in & recovery
              <small>
                {account.assurance === 'phone_demo'
                  ? 'Your verified mobile number.'
                  : 'Passkeys, recovery codes, peace of mind.'}
              </small>
            </span>
            <ChevronRight size={17} />
          </button>
          {messagingAvailable && (
            <button
              onClick={() => {
                setProfileOpen(false);
                onMessages();
              }}
            >
              <MessageCircle size={19} />
              <span>
                Tallie in Messages<small>Your assistant, one conversation away.</small>
              </span>
              <ChevronRight size={17} />
            </button>
          )}
        </div>
        <Button variant="ghost" fullWidth loading={signingOut} onClick={() => void signOut()}>
          Sign out
        </Button>
      </Dialog>
    </div>
  );
}

function ExpenseList({
  expenses,
  onOpen,
}: {
  expenses: SocialExpense[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="account-expense-list">
      {expenses.map((expense) => {
        const own = expense.shares.find((share) => share.isYou);
        const awaiting = expense.shares.filter((share) => share.status === 'invite_ready').length;
        const canceled = expense.shares
          .filter((share) => share.status !== 'self' && share.status !== 'no_payment')
          .every((share) => share.status === 'canceled');
        return (
          <button
            className="account-expense-row"
            key={expense.id}
            onClick={() => onOpen(expense.id)}
          >
            <span
              className={`account-moment-emoji category-${expense.category}`}
              aria-hidden="true"
            >
              {expense.emoji}
            </span>
            <span className="account-moment-copy">
              <strong>
                {expense.title}
                {expense.paymentEnvironment === 'sandbox' && (
                  <span className="account-test-badge">TEST</span>
                )}
              </strong>
              <span>
                {expense.isOwner ? 'You' : expense.paidByName.split(' ')[0]} paid ·{' '}
                {shortDate(expense.createdAt)}
                <span className="account-moment-count"> · {expense.shares.length} people</span>
              </span>
            </span>
            <span className="account-moment-amount">
              <strong>
                {money(expense.isOwner ? expense.totalMinor : (own?.amountMinor ?? '0'))}
              </strong>
              <span>
                {canceled
                  ? 'Canceled'
                  : expense.isOwner
                    ? awaiting
                      ? `${awaiting} invite${awaiting === 1 ? '' : 's'} ready`
                      : 'Split saved'
                    : own?.status === 'canceled'
                      ? 'Canceled'
                      : expense.paymentEnvironment === 'sandbox'
                        ? own?.sandboxPayment?.status === 'paid'
                          ? 'Test share paid'
                          : own?.sandboxPayment?.status === 'returned'
                            ? 'Test payment returned'
                            : own?.sandboxPayment?.status === 'processing' ||
                                own?.sandboxPayment?.status === 'unknown'
                              ? 'Checking test payment'
                              : 'Your test share'
                        : 'Your share'}
              </span>
            </span>
            <ChevronRight size={17} />
          </button>
        );
      })}
    </div>
  );
}
