import { ArrowUpRight, Check, ChevronRight, Receipt } from 'lucide-react';
import type { Dashboard } from '@tallie/db/contracts';
import { money, shortDate } from '@/lib/client';
import { EmptyState } from '../moments';

interface ActivityScreenProps {
  data: Dashboard;
  onExpenseSelect: (expenseId: string) => void;
}
export function ActivityScreen({ data, onExpenseSelect }: ActivityScreenProps) {
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="greeting">Every little thing, in one place.</p>
          <h1>
            The good <em>kind of history.</em>
          </h1>
        </div>
        <div className="settled-note">
          <Check size={18} />
          <span>{money(data.summary.settledMinor)} settled this month</span>
        </div>
      </section>
      <section className="activity-list">
        {data.activity.length ? (
          data.activity.map((item) => (
            <div key={item.id} className="activity-row">
              <span
                className={`activity-icon ${item.type.startsWith('payment') ? 'is-payment' : ''}`}
              >
                {item.type.startsWith('payment') ? (
                  <ArrowUpRight size={20} />
                ) : (
                  <Receipt size={20} />
                )}
              </span>
              <div className="activity-copy">
                <strong>{item.title}</strong>
                <p>{item.description}</p>
              </div>
              <div className="activity-right">
                {item.amountMinor && <strong>{money(item.amountMinor)}</strong>}
                <span>{shortDate(item.createdAt)}</span>
              </div>
              {item.expenseId && (
                <button
                  className="icon-button"
                  aria-label={`View ${item.title}`}
                  onClick={() => item.expenseId && onExpenseSelect(item.expenseId)}
                >
                  <ChevronRight size={18} />
                </button>
              )}
            </div>
          ))
        ) : (
          <EmptyState
            title="A fresh start."
            description="Your splits and payments will find a home here."
          />
        )}
      </section>
    </>
  );
}
