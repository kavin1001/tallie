'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Home,
  Plus,
  Send,
  Users,
} from 'lucide-react';
import type { Dashboard, PaymentRequest, PaymentReview, Person } from '@tallie/db/contracts';
import { Avatar, Button, Dialog, ToastProvider, useToast } from './ui';
import { Flower, ReceiptArt, Wordmark } from './brand';
import { NewSplit } from './new-split';
import { ExpensePanel } from './expense-panel';
import { PaymentFlow } from './payment-flow';
import { SendMoney } from './send-money';
import { PhoneVerification } from './phone-verification';
import { api, errorMessage, RequestError } from '@/lib/client';
import { EmptyState, ExpenseRow } from './moments';
import { HomeScreen, type ExpenseFilter } from './screens/home-screen';
import { PeopleScreen } from './screens/people-screen';
import { ActivityScreen } from './screens/activity-screen';

type Page = 'home' | 'people' | 'activity';
export function TallieApp() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<Page>('home');
  const [filter, setFilter] = useState<ExpenseFilter>('all');
  const [query, setQuery] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<string | null>(null);
  const [review, setReview] = useState<PaymentReview | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState<Person | 'choose' | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [person, setPerson] = useState<Person | null>(null);
  const [switching, setSwitching] = useState(false);
  const { toast } = useToast();
  const reviewLock = useRef(false);
  const dashboardGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const personaChangeInFlight = useRef(false);
  const activePersonId = useRef<string | null>(null);

  const discardFlows = useCallback(() => {
    reviewLock.current = false;
    setSplitOpen(false);
    setSelectedExpense(null);
    setReview(null);
    setReviewing(null);
    setSendTo(null);
    setProfileOpen(false);
    setPhoneOpen(false);
    setChannelOpen(false);
    setPerson(null);
    setFilter('all');
    setQuery('');
  }, []);

  const acceptDashboard = useCallback(
    (next: Dashboard) => {
      if (activePersonId.current && activePersonId.current !== next.user.id) {
        // Another tab can switch the shared session's persona too.
        dashboardGeneration.current += 1;
        discardFlows();
      }
      activePersonId.current = next.user.id;
      setData(next);
      setError('');
    },
    [discardFlows],
  );

  const expireSession = useCallback(() => {
    dashboardGeneration.current += 1;
    refreshSequence.current += 1;
    activePersonId.current = null;
    discardFlows();
    setData(null);
    setPage('home');
    setError('Your demo session expired. Start a fresh demo to continue.');
  }, [discardFlows]);

  const refresh = useCallback(async () => {
    if (personaChangeInFlight.current) return;
    const generation = dashboardGeneration.current;
    const sequence = ++refreshSequence.current;
    const isCurrent = () =>
      generation === dashboardGeneration.current &&
      sequence === refreshSequence.current &&
      !personaChangeInFlight.current;
    try {
      const next = await api<Dashboard>('/api/dashboard');
      if (isCurrent()) acceptDashboard(next);
      return next;
    } catch (cause) {
      if (isCurrent() && cause instanceof RequestError && cause.status === 401) {
        expireSession();
      }
      throw cause;
    }
  }, [acceptDashboard, expireSession]);
  useEffect(() => {
    let live = true;
    api<Dashboard>('/api/dashboard')
      .then((next) => {
        if (live) acceptDashboard(next);
      })
      .catch((e) => {
        if (live && !(e instanceof RequestError && e.status === 401)) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [acceptDashboard]);
  useEffect(() => {
    if (!data) return;
    const onFocus = () => {
      refresh().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [data, refresh]);
  useEffect(() => {
    if (!data?.requests.some((request) => request.status === 'processing')) return;
    const interval = setInterval(() => {
      refresh().catch(() => undefined);
    }, 2000);
    return () => clearInterval(interval);
  }, [data, refresh]);

  async function startDemo() {
    if (starting) return;
    setStarting(true);
    setError('');
    dashboardGeneration.current += 1;
    try {
      acceptDashboard(await api<Dashboard>('/api/demo/session', {}));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }
  async function openReview(request: PaymentRequest) {
    if (reviewLock.current || personaChangeInFlight.current) return;
    const generation = dashboardGeneration.current;
    reviewLock.current = true;
    setReviewing(request.id);
    try {
      const next = await api<PaymentReview>(`/api/requests/${request.id}/review`, {});
      if (generation !== dashboardGeneration.current) return;
      setReview(next);
      setSelectedExpense(null);
      setPerson(null);
    } catch (e) {
      if (generation !== dashboardGeneration.current) return;
      if (e instanceof RequestError && e.status === 401) {
        expireSession();
        return;
      }
      toast({
        title: 'Couldn’t prepare this payment',
        description: errorMessage(e),
        tone: 'error',
      });
      await refresh().catch(() => undefined);
    } finally {
      if (generation === dashboardGeneration.current) {
        reviewLock.current = false;
        setReviewing(null);
      }
    }
  }
  async function switchPersona(personId: string) {
    if (personaChangeInFlight.current) return;
    personaChangeInFlight.current = true;
    // Responses from the previous identity cannot replace this identity's view.
    dashboardGeneration.current += 1;
    reviewLock.current = false;
    setReviewing(null);
    setSwitching(true);
    let needsReconciliation = false;
    try {
      acceptDashboard(await api<Dashboard>('/api/demo/persona', { personId }));
      discardFlows();
      toast({
        title: 'A different point of view',
        description: 'You’re exploring as another demo friend.',
      });
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) {
        expireSession();
      } else {
        needsReconciliation = true;
        toast({
          title: 'Checking your current view',
          description: errorMessage(e),
          tone: 'error',
        });
      }
    } finally {
      personaChangeInFlight.current = false;
      setSwitching(false);
    }

    if (needsReconciliation) {
      // A lost response does not prove the server kept the previous persona.
      // Hide private state until the authoritative session has been read again.
      discardFlows();
      setData(null);
      setLoading(true);
      try {
        await refresh();
      } catch (cause) {
        if (!(cause instanceof RequestError && cause.status === 401)) {
          setError('We couldn’t restore your demo. Reload to try again, or start a fresh demo.');
        }
      } finally {
        setLoading(false);
      }
    }
  }

  if (loading)
    return (
      <main className="loading-screen">
        <Wordmark />
        <div className="loading-flower">
          <Flower />
        </div>
        <p>Getting everything together…</p>
      </main>
    );
  if (!data)
    return (
      <div className="welcome-page">
        <header className="welcome-header">
          <Wordmark />
          <span className="demo-pill">
            <span />A first look
          </span>
        </header>
        <main className="welcome-main">
          <section className="welcome-copy">
            <div className="eyebrow">
              <span className="tiny-line" />
              MONEY BETWEEN FRIENDS, REIMAGINED
            </div>
            <h1>
              Good times.
              <br />
              <em>All square.</em>
            </h1>
            <p>
              A little less settling up.
              <br />A little more living.
            </p>
            <Button size="lg" onClick={startDemo} loading={starting}>
              Take Tallie for a spin <ArrowRight size={18} />
            </Button>
            <span className="welcome-note">A private demo. No bank account. No real money.</span>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </section>
          <ReceiptArt />
        </main>
        <footer className="welcome-footer">
          <span>For dinners, detours, and everything in between.</span>
          <span>
            Made for the people you do life with <Flower />
          </span>
        </footer>
      </div>
    );

  const incoming = data.requests.filter(
    (r) =>
      r.to.id === data.user.id &&
      (r.status === 'open' || r.status === 'processing' || r.status === 'issue'),
  );
  const flowGeneration = dashboardGeneration.current;
  const expenses = data.expenses.filter((expense) => {
    if (
      query &&
      !`${expense.title} ${expense.participants.map((p) => p.person.name).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false;
    if (filter === 'settled') return expense.status === 'settled';
    if (filter === 'owed') return expense.paidBy.id === data.user.id && expense.status === 'open';
    if (filter === 'owe')
      return (
        expense.paidBy.id !== data.user.id &&
        expense.participants.some(
          (p) => p.person.id === data.user.id && ['open', 'processing', 'issue'].includes(p.status),
        )
      );
    return true;
  });

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <button className="brand-button" onClick={() => setPage('home')} aria-label="Tallie home">
            <Wordmark />
          </button>
          <nav className="desktop-nav" aria-label="Main navigation">
            {(['home', 'people', 'activity'] as const).map((item) => (
              <button
                key={item}
                aria-current={page === item ? 'page' : undefined}
                onClick={() => {
                  setPage(item);
                  setQuery('');
                }}
              >
                {item.charAt(0).toUpperCase() + item.slice(1)}
              </button>
            ))}
          </nav>
          <div className="header-end">
            <span className="demo-pill">
              <span />
              Demo
            </span>
            <button
              className="profile-button"
              onClick={() => setProfileOpen(true)}
              aria-label={`Your profile: ${data.user.name}`}
            >
              <Avatar name={data.user.name} size="sm" />
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="main-content">
        {page === 'home' && (
          <HomeScreen
            data={data}
            expenses={expenses}
            incoming={incoming}
            filter={filter}
            query={query}
            reviewing={reviewing}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onExpenseSelect={setSelectedExpense}
            onReview={openReview}
            onNewSplit={() => setSplitOpen(true)}
            onSendMoney={() => setSendTo('choose')}
            onChannelOpen={() => setChannelOpen(true)}
          />
        )}
        {page === 'people' && (
          <PeopleScreen
            data={data}
            onNewSplit={() => setSplitOpen(true)}
            onSelectPerson={setPerson}
          />
        )}
        {page === 'activity' && <ActivityScreen data={data} onExpenseSelect={setSelectedExpense} />}
        <footer className="app-footer">
          <Wordmark />
          <span>Good times. All square.</span>
          <span className="demo-disclosure">Demo experience · No real money moves</span>
        </footer>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(
          [
            { id: 'home', label: 'Home', icon: Home },
            { id: 'people', label: 'People', icon: Users },
            { id: 'activity', label: 'Activity', icon: History },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => setPage(item.id)}
          >
            <item.icon size={21} strokeWidth={1.7} />
            <span>{item.label}</span>
          </button>
        ))}
        <button onClick={() => setSplitOpen(true)}>
          <Plus size={22} />
          <span>New split</span>
        </button>
      </nav>
      {splitOpen && (
        <NewSplit
          data={data}
          onClose={() => setSplitOpen(false)}
          onCreated={async (expense) => {
            if (flowGeneration !== dashboardGeneration.current) return;
            await refresh();
            if (flowGeneration !== dashboardGeneration.current) return;
            setSplitOpen(false);
            setSelectedExpense(expense.id);
            toast({
              title: 'A good time, fairly shared.',
              description: 'Individual requests are ready in this demo.',
            });
          }}
        />
      )}
      {selectedExpense && (
        <ExpensePanel
          key={`${data.user.id}:${selectedExpense}`}
          expenseId={selectedExpense}
          data={data}
          reviewing={reviewing}
          onClose={() => setSelectedExpense(null)}
          onPay={openReview}
          onChanged={refresh}
          onSessionExpired={expireSession}
        />
      )}
      {review && (
        <PaymentFlow review={review} onClose={() => setReview(null)} onChanged={refresh} />
      )}
      {sendTo && (
        <SendMoney
          data={data}
          initialPerson={sendTo === 'choose' ? undefined : sendTo}
          onClose={() => setSendTo(null)}
          onReview={(next) => {
            if (flowGeneration !== dashboardGeneration.current) return;
            setSendTo(null);
            setReview(next);
          }}
        />
      )}
      {phoneOpen && <PhoneVerification onClose={() => setPhoneOpen(false)} />}
      <Dialog
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Make yourself at home."
        description="Explore both sides of a split. These demo profiles only exist in your private session."
      >
        <div className="persona-list">
          {data.people.map((p) => (
            <button key={p.id} disabled={switching} onClick={() => switchPersona(p.id)}>
              <Avatar name={p.name} />
              <span>
                {p.name}
                {p.id === data.user.id && <small>Your current view</small>}
              </span>
              {p.id === data.user.id ? <Check size={18} /> : <ChevronRight size={18} />}
            </button>
          ))}
        </div>
        <p className="fine-print">
          Simulated balances and payments. This is not an account with Natural.
        </p>
        {data.capabilities.phoneVerification && (
          <Button
            variant="secondary"
            fullWidth
            onClick={() => {
              setProfileOpen(false);
              setPhoneOpen(true);
            }}
          >
            Try phone verification <ArrowRight size={16} />
          </Button>
        )}
      </Dialog>
      <Dialog
        open={channelOpen}
        onClose={() => setChannelOpen(false)}
        title="Soon, as easy as a text."
        description="The Tallie iMessage agent is the next chapter."
      >
        <div className="chat-preview">
          <div className="chat-bubble outgoing">
            Dinner with Maya and Leo. I covered it.
            <span>Split by item — Maya skipped the wine.</span>
          </div>
          <div className="chat-bubble incoming">
            A good night, fairly shared.
            <div>
              Maya <b>$26.00</b>
            </div>
            <div>
              Leo <b>$45.50</b>
            </div>
            <small>Each person reviews and approves their own payment.</small>
          </div>
        </div>
        <p className="fine-print">
          An illustrated preview. Messaging isn’t connected yet. You can try the same split in the
          web app now.
        </p>
        <Button
          fullWidth
          onClick={() => {
            setChannelOpen(false);
            setSplitOpen(true);
          }}
        >
          Try a split <ArrowRight size={17} />
        </Button>
      </Dialog>
      <Dialog
        open={Boolean(person)}
        onClose={() => setPerson(null)}
        title={person ? `You & ${person.firstName}` : 'Your friend'}
        description="Your recent shared moments, with the details out in the open."
      >
        {person && (
          <>
            <div className="friend-actions">
              <Avatar name={person.name} size="xl" />
              <Button
                variant="secondary"
                onClick={() => {
                  setSendTo(person);
                  setPerson(null);
                }}
              >
                <Send size={16} />
                Send money
              </Button>
            </div>
            <div className="friend-expenses">
              {!data.expenses.some((expense) =>
                expense.participants.some((p) => p.person.id === person.id),
              ) && (
                <EmptyState
                  title="Room for a new memory."
                  description="No shared moments in your recent history. Older history isn’t loaded in this demo."
                />
              )}
              {data.expenses
                .filter((e) => e.participants.some((p) => p.person.id === person.id))
                .map((expense) => (
                  <ExpenseRow
                    key={expense.id}
                    expense={expense}
                    userId={data.user.id}
                    onClick={() => {
                      setPerson(null);
                      setSelectedExpense(expense.id);
                    }}
                  />
                ))}
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
