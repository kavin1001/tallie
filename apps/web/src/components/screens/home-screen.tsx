import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  MessageCircle,
  Plus,
  Receipt,
  Search,
} from 'lucide-react';
import type { Dashboard, ExpenseSummary, PaymentRequest } from '@tallie/db/contracts';
import { money } from '@/lib/client';
import { Flower } from '../brand';
import { EmptyState, ExpenseRow } from '../moments';
import { Avatar, Button } from '../ui';

export type ExpenseFilter = 'all' | 'owe' | 'owed' | 'settled';
interface HomeScreenProps {
  data: Dashboard;
  expenses: ExpenseSummary[];
  incoming: PaymentRequest[];
  filter: ExpenseFilter;
  query: string;
  reviewing: string | null;
  onFilterChange: (filter: ExpenseFilter) => void;
  onQueryChange: (query: string) => void;
  onExpenseSelect: (expenseId: string) => void;
  onReview: (request: PaymentRequest) => Promise<void>;
  onNewSplit: () => void;
  onSendMoney: () => void;
  onChannelOpen: () => void;
}
export function HomeScreen({
  data,
  expenses,
  incoming,
  filter,
  query,
  reviewing,
  onFilterChange,
  onQueryChange,
  onExpenseSelect,
  onReview,
  onNewSplit,
  onSendMoney,
  onChannelOpen,
}: HomeScreenProps) {
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="greeting">A little more time for the good stuff, {data.user.firstName}.</p>
          <h1>
            Life’s better <em>shared.</em>
            <Flower />
          </h1>
        </div>
        <div className="heading-actions">
          <Button variant="secondary" onClick={() => onSendMoney()}>
            <ArrowUpRight size={17} />
            Send money
          </Button>
          <Button onClick={() => onNewSplit()}>
            <Plus size={18} />
            New split
          </Button>
        </div>
      </section>
      <section className="overview-grid" aria-label="Your payment overview">
        <div className="overview-primary">
          <div className="overview-label">
            <span className="stat-icon">
              <ArrowDownLeft size={17} />
            </span>
            Coming your way
          </div>
          <div className="primary-amount">{money(data.summary.owedToYouMinor)}</div>
          <div className="overview-bottom">
            <span>From shared moments</span>
            <button
              aria-label="View what you’re owed"
              onClick={() => {
                onFilterChange('owed');
                document.getElementById('moments')?.scrollIntoView({
                  behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 'instant'
                    : 'smooth',
                  block: 'start',
                });
              }}
            >
              <ArrowUpRight size={22} />
            </button>
          </div>
          <Flower className="card-flower" />
        </div>
        <div className="overview-secondary">
          <div className="overview-label">
            <span className="stat-icon">
              <ArrowUpRight size={17} />
            </span>
            On your side
          </div>
          <div className="secondary-amount">{money(data.summary.owingMinor)}</div>
          <p>
            {incoming.length
              ? `${incoming.length} ${incoming.length === 1 ? 'moment' : 'moments'} to settle up`
              : 'You’re all caught up. Nice.'}
          </p>
        </div>
        <button className="new-split-card" onClick={() => onNewSplit()}>
          <div className="mini-receipts">
            <span />
            <span>
              <Receipt size={25} strokeWidth={1.4} />
            </span>
            <i>＋</i>
          </div>
          <div>
            <h2>Split the moment.</h2>
            <p>Dinner, a weekend away, that coffee run.</p>
          </div>
          <span className="text-link">
            Make it even <ArrowRight size={16} />
          </span>
        </button>
      </section>
      <div className="content-grid">
        <section id="moments" className="moments-section">
          <div className="section-title">
            <h2>
              Your moments<span>{data.expenses.length}</span>
            </h2>
            <label className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Find a moment"
                aria-label="Search moments"
              />
            </label>
          </div>
          <div className="filter-row" aria-label="Filter expenses">
            {(
              [
                { id: 'all', label: 'All moments' },
                { id: 'owe', label: 'You owe' },
                { id: 'owed', label: 'You’re owed' },
                { id: 'settled', label: 'All square' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                aria-pressed={filter === item.id}
                className={filter === item.id ? 'active' : ''}
                onClick={() => onFilterChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="expense-list">
            {expenses.length ? (
              expenses.map((expense) => (
                <ExpenseRow
                  key={expense.id}
                  expense={expense}
                  userId={data.user.id}
                  onClick={() => onExpenseSelect(expense.id)}
                />
              ))
            ) : (
              <EmptyState
                title="A little breathing room."
                description={
                  query
                    ? 'No moments match that search.'
                    : 'Nothing here right now. The next good moment is yours to make.'
                }
              />
            )}
          </div>
          <div className="list-footnote">
            <span className="small-flower">✳</span> Good memories. Clear numbers.
          </div>
        </section>
        <aside className="sidebar">
          <section className="up-next">
            <div className="section-title">
              <h2>A little on your plate</h2>
              <span className="count-dot">{incoming.length}</span>
            </div>
            {incoming.length ? (
              incoming.slice(0, 3).map((request) => (
                <div className="request-card" key={request.id}>
                  <div className="request-top">
                    <Avatar name={request.from.name} />
                    <div>
                      <strong>{request.from.firstName}</strong>
                      <span>{request.title}</span>
                    </div>
                    <b>{money(request.amountMinor)}</b>
                  </div>
                  <div className="request-bottom">
                    <button onClick={() => onExpenseSelect(request.expenseId)}>
                      See the split <ChevronRight size={13} />
                    </button>
                    {request.status === 'open' ? (
                      <Button
                        size="sm"
                        loading={reviewing === request.id}
                        onClick={() => onReview(request)}
                      >
                        Review & pay <ArrowUpRight size={14} />
                      </Button>
                    ) : (
                      <span className="status-chip">
                        {request.status === 'processing' ? 'On its way' : 'Needs a look'}
                      </span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="caught-up">
                <span>
                  <Check size={22} />
                </span>
                <h3>All caught up.</h3>
                <p>That’s a good feeling.</p>
              </div>
            )}
          </section>
          <button className="message-card" onClick={() => onChannelOpen()}>
            <span className="message-icon">
              <MessageCircle size={20} />
            </span>
            <div>
              <span className="eyebrow-small">A PEEK AT WHAT’S NEXT</span>
              <h3>Just text it.</h3>
              <p>
                A receipt. A few friends.
                <br />
                We’ll take it from there.
              </p>
            </div>
            <ArrowUpRight size={19} />
            <span className="coming-soon">iMessage · Coming soon</span>
          </button>
          <div className="sidebar-note">
            <Flower />
            <p>
              Less money talk.
              <br />
              More <em>“same time next week?”</em>
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
