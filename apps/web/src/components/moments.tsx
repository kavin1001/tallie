import {
  Check,
  ChevronRight,
  Coffee,
  Plane,
  Receipt,
  ShoppingBasket,
  Ticket,
  Utensils,
} from 'lucide-react';
import type { Category, ExpenseSummary } from '@tallie/db/contracts';
import { money, shortDate } from '@/lib/client';
import { Flower } from './brand';
import { Avatar } from './ui';

export function CategoryIcon({ category, size = 22 }: { category: Category; size?: number }) {
  const Icon = {
    dinner: Utensils,
    travel: Plane,
    coffee: Coffee,
    groceries: ShoppingBasket,
    tickets: Ticket,
    other: Receipt,
  }[category];
  return (
    <span className={`category-icon category-${category}`}>
      <Icon size={size} strokeWidth={1.6} />
    </span>
  );
}
export function ExpenseRow({
  expense,
  userId,
  onClick,
}: {
  expense: ExpenseSummary;
  userId: string;
  onClick: () => void;
}) {
  const mine = expense.participants.find((p) => p.person.id === userId);
  const isPayer = expense.paidBy.id === userId;
  const outstanding = expense.participants
    .filter((p) => ['open', 'processing', 'issue'].includes(p.status))
    .reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
  const settled = expense.status === 'settled';
  const canceled = expense.status === 'canceled';
  return (
    <button className="expense-row" onClick={onClick}>
      <CategoryIcon category={expense.category} />
      <div className="expense-copy">
        <h3>{expense.title}</h3>
        <p>
          {isPayer ? 'You' : expense.paidBy.firstName} paid {money(expense.totalMinor)}
          <span>·</span>
          {shortDate(expense.createdAt)}
        </p>
        <div className="expense-avatars">
          {expense.participants.slice(0, 4).map((p) => (
            <Avatar key={p.person.id} name={p.person.name} size="xs" />
          ))}
          <span>{expense.participants.length} people</span>
        </div>
      </div>
      <div
        className={`expense-amount ${settled ? 'amount-settled' : isPayer ? 'amount-owed' : ''}`}
      >
        <strong>
          {settled ? (
            <>
              <Check size={14} />
              All square
            </>
          ) : canceled ? (
            'Closed'
          ) : mine?.status === 'canceled' ? (
            'Canceled'
          ) : (
            money(isPayer ? outstanding : (mine?.amountMinor ?? '0'))
          )}
        </strong>
        <span>
          {canceled
            ? 'Contains canceled shares'
            : mine?.status === 'canceled'
              ? 'Your request'
              : mine?.status === 'no_payment'
                ? 'No payment needed'
                : settled
                  ? 'Feels good, doesn’t it?'
                  : isPayer
                    ? 'you’re owed'
                    : mine?.status === 'paid'
                      ? 'your share · paid'
                      : mine?.status === 'processing'
                        ? 'on its way'
                        : 'your share'}
        </span>
      </div>
      <ChevronRight className="row-chevron" size={17} />
    </button>
  );
}
export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <Flower />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
