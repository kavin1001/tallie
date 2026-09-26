import { database, type Database } from '@tallie/db';
import type {
  Activity,
  Allocation,
  Dashboard,
  ExpenseDetailData,
  ExpenseSummary,
  Operation,
  PaymentRequest,
  PaymentReview,
  Person,
} from '@tallie/db/contracts';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { notFound } from './errors';
import type { Principal } from './session';

type ReadDatabase = Kysely<Database> | Transaction<Database>;

function personView(row: Selectable<Database['people']>): Person {
  return {
    id: row.id,
    name: row.name,
    firstName: row.name.split(' ')[0] ?? row.name,
    initials: row.initials,
    color: row.color,
    venmoHandle: row.venmo_handle,
  };
}

export async function getPeople(
  principal: Principal,
  db: ReadDatabase = database(),
): Promise<Person[]> {
  const rows = await db
    .selectFrom('people')
    .selectAll()
    .where('workspace_id', '=', principal.workspaceId)
    .orderBy('created_at')
    .orderBy('name')
    .execute();
  return rows.map(personView);
}

function indexedPeople(people: Person[]): (id: string) => Person {
  const index = new Map(people.map((person) => [person.id, person]));
  return (id) => {
    const person = index.get(id);
    if (!person) throw new Error('A domain record references an inaccessible person.');
    return person;
  };
}

function requestView(
  request: Selectable<Database['payment_requests']> & { title: string; emoji: string },
  principal: Principal,
  person: (id: string) => Person,
): PaymentRequest {
  const allowedActions: PaymentRequest['allowedActions'] = ['view_expense'];
  if (request.status === 'open') {
    if (request.debtor_id === principal.personId)
      allowedActions.push('review_payment', 'raise_issue');
    if (request.payee_id === principal.personId) allowedActions.push('cancel_request');
  }
  if (request.status === 'issue' && request.payee_id === principal.personId)
    allowedActions.push('cancel_request');
  return {
    id: request.id,
    expenseId: request.expense_id,
    title: request.title,
    emoji: request.emoji,
    from: person(request.payee_id),
    to: person(request.debtor_id),
    amountMinor: request.amount_minor,
    currency: 'USD',
    status: request.status,
    version: request.version,
    createdAt: request.created_at.toISOString(),
    issueReason: request.issue_reason,
    allowedActions,
  };
}

async function visibleExpenses(
  principal: Principal,
  people: Person[],
  db: ReadDatabase,
  expenseId?: string,
): Promise<ExpenseSummary[]> {
  let query = db
    .selectFrom('expenses')
    .innerJoin('expense_allocations as membership', 'membership.expense_id', 'expenses.id')
    .selectAll('expenses')
    .where('expenses.workspace_id', '=', principal.workspaceId)
    .where('membership.person_id', '=', principal.personId);
  if (expenseId) query = query.where('expenses.id', '=', expenseId);
  const expenses = await query.orderBy('expenses.created_at', 'desc').limit(100).execute();
  if (expenses.length === 0) return [];
  const ids = expenses.map((expense) => expense.id);
  const [allocations, requests] = await Promise.all([
    db
      .selectFrom('expense_allocations')
      .selectAll()
      .where('workspace_id', '=', principal.workspaceId)
      .where('expense_id', 'in', ids)
      .execute(),
    db
      .selectFrom('payment_requests')
      .selectAll()
      .where('workspace_id', '=', principal.workspaceId)
      .where('expense_id', 'in', ids)
      .execute(),
  ]);
  const person = indexedPeople(people);
  return expenses.map((expense) => {
    const expenseRequests = requests.filter((request) => request.expense_id === expense.id);
    const allPaid = expenseRequests.every((request) => request.status === 'paid');
    const closedWithCancellation =
      expenseRequests.some((request) => request.status === 'canceled') &&
      expenseRequests.every(
        (request) => request.status === 'canceled' || request.status === 'paid',
      );
    return {
      id: expense.id,
      title: expense.title,
      emoji: expense.emoji,
      category: expense.category,
      totalMinor: expense.total_minor,
      currency: 'USD',
      method: expense.method,
      paidBy: person(expense.paid_by_id),
      createdAt: expense.created_at.toISOString(),
      status: allPaid ? 'settled' : closedWithCancellation ? 'canceled' : 'open',
      version: expense.version,
      participants: allocations
        .filter((allocation) => allocation.expense_id === expense.id)
        .map((allocation): Allocation => {
          const request = expenseRequests.find((entry) => entry.debtor_id === allocation.person_id);
          return {
            person: person(allocation.person_id),
            amountMinor: allocation.amount_minor,
            requestId: request?.id ?? null,
            status:
              request?.status ??
              (allocation.person_id === expense.paid_by_id ? 'self' : 'no_payment'),
          };
        })
        .sort((left, right) =>
          left.person.id === expense.paid_by_id
            ? -1
            : right.person.id === expense.paid_by_id
              ? 1
              : left.person.name.localeCompare(right.person.name),
        ),
      items: expense.items,
      subtotalMinor: expense.subtotal_minor,
      taxMinor: expense.tax_minor,
      tipMinor: expense.tip_minor,
      discountMinor: expense.discount_minor,
      receiptKind: expense.receipt_kind,
    };
  });
}

export async function getExpense(
  principal: Principal,
  id: string,
  db: ReadDatabase = database(),
): Promise<ExpenseSummary> {
  const people = await getPeople(principal, db);
  const expense = (await visibleExpenses(principal, people, db, id))[0];
  if (!expense) notFound();
  return expense;
}

export async function getExpenseDetail(
  principal: Principal,
  id: string,
  db: Kysely<Database> = database(),
): Promise<ExpenseDetailData> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      const people = await getPeople(principal, tx);
      const expense = (await visibleExpenses(principal, people, tx, id))[0];
      if (!expense) notFound();
      // Receipt membership grants transparency into shares, not access to another
      // pair's issue notes or authority over their requests.
      const requestRows = await tx
        .selectFrom('payment_requests')
        .selectAll()
        .where('workspace_id', '=', principal.workspaceId)
        .where('expense_id', '=', id)
        .where((eb) =>
          eb.or([
            eb('debtor_id', '=', principal.personId),
            eb('payee_id', '=', principal.personId),
          ]),
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const person = indexedPeople(people);
      return {
        expense,
        requests: requestRows.map((request) =>
          requestView(
            { ...request, title: expense.title, emoji: expense.emoji },
            principal,
            person,
          ),
        ),
      };
    });
}

export async function getDashboard(
  principal: Principal,
  db: Kysely<Database> = database(),
): Promise<Dashboard> {
  // A repeatable-read snapshot keeps totals, request states, and cards consistent
  // when the simulator completes a payment during this read.
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      const people = await getPeople(principal, tx);
      const person = indexedPeople(people);
      const counterparty = sql<string>`case when payee_id = ${principal.personId}::uuid then debtor_id else payee_id end`;
      const [expenses, requestRows, activityRows, settled, balances] = await Promise.all([
        visibleExpenses(principal, people, tx),
        tx
          .selectFrom('payment_requests as request')
          .innerJoin('expenses as expense', 'expense.id', 'request.expense_id')
          .selectAll('request')
          .select(['expense.title', 'expense.emoji'])
          .where('request.workspace_id', '=', principal.workspaceId)
          .where((eb) =>
            eb.or([
              eb('request.debtor_id', '=', principal.personId),
              eb('request.payee_id', '=', principal.personId),
            ]),
          )
          .orderBy('request.created_at', 'desc')
          .limit(200)
          .execute(),
        tx
          .selectFrom('activity')
          .selectAll()
          .where('workspace_id', '=', principal.workspaceId)
          .where('user_id', '=', principal.personId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute(),
        tx
          .selectFrom('settlement_events as event')
          .innerJoin('operations as operation', 'operation.id', 'event.operation_id')
          .select(sql<string>`coalesce(sum(event.amount_minor), 0)::text`.as('total'))
          .where('event.workspace_id', '=', principal.workspaceId)
          .where('event.created_at', '>=', sql<Date>`date_trunc('month', now())`)
          .where((eb) =>
            eb.or([
              eb('operation.payer_id', '=', principal.personId),
              eb('operation.payee_id', '=', principal.personId),
            ]),
          )
          .executeTakeFirstOrThrow(),
        tx
          .selectFrom('payment_requests')
          .select([
            counterparty.as('person_id'),
            sql<string>`coalesce(sum(amount_minor) filter (where payee_id = ${principal.personId}::uuid), 0)::text`.as(
              'owed',
            ),
            sql<string>`coalesce(sum(amount_minor) filter (where debtor_id = ${principal.personId}::uuid), 0)::text`.as(
              'owing',
            ),
          ])
          .where('workspace_id', '=', principal.workspaceId)
          .where('status', 'in', ['open', 'processing', 'issue'])
          .where((eb) =>
            eb.or([
              eb('debtor_id', '=', principal.personId),
              eb('payee_id', '=', principal.personId),
            ]),
          )
          .groupBy(sql.ref('person_id'))
          .execute(),
      ]);
      const balanceByPerson = new Map(balances.map((balance) => [balance.person_id, balance]));
      const personBalances = people
        .filter((entry) => entry.id !== principal.personId)
        .map((entry) => ({
          personId: entry.id,
          owedToYouMinor: balanceByPerson.get(entry.id)?.owed ?? '0',
          owingMinor: balanceByPerson.get(entry.id)?.owing ?? '0',
        }));
      const requests = requestRows.map((request) => requestView(request, principal, person));
      const activity: Activity[] = activityRows.map((event) => ({
        id: event.id,
        type: event.type,
        title: event.title,
        description: event.description,
        emoji: event.emoji,
        amountMinor: event.amount_minor,
        person: event.person_id ? person(event.person_id) : null,
        expenseId: event.expense_id,
        operationId: event.operation_id,
        createdAt: event.created_at.toISOString(),
      }));
      return {
        mode: 'demo',
        user: person(principal.personId),
        people,
        personBalances,
        expenses,
        requests,
        activity,
        summary: {
          owedToYouMinor: personBalances
            .reduce((total, balance) => total + BigInt(balance.owedToYouMinor), 0n)
            .toString(),
          owingMinor: personBalances
            .reduce((total, balance) => total + BigInt(balance.owingMinor), 0n)
            .toString(),
          settledMinor: settled.total,
        },
        capabilities: {
          natural: false,
          imessage: false,
          receiptUpload: process.env.RECEIPTS_ENABLED === 'true',
          phoneVerification: Boolean(
            process.env.SENDBLUE_API_KEY_ID &&
            process.env.SENDBLUE_API_SECRET_KEY &&
            process.env.SENDBLUE_VERIFY_SERVICE_SID &&
            process.env.SENDBLUE_PHONE_ENCRYPTION_KEY,
          ),
          venmo: false,
        },
      };
    });
}

export async function getReview(
  principal: Principal,
  id: string,
  db: ReadDatabase = database(),
): Promise<PaymentReview> {
  const review = await db
    .selectFrom('payment_reviews')
    .selectAll()
    .where('workspace_id', '=', principal.workspaceId)
    .where('id', '=', id)
    .where('payer_id', '=', principal.personId)
    .where('session_id', '=', principal.sessionId)
    .executeTakeFirst();
  if (!review) notFound();
  const person = indexedPeople(await getPeople(principal, db));
  return {
    id: review.id,
    requestId: review.request_id,
    requestVersion: review.request_version,
    kind: review.kind,
    amountMinor: review.amount_minor,
    feeMinor: '0',
    totalMinor: review.amount_minor,
    currency: 'USD',
    from: person(review.payer_id),
    to: person(review.payee_id),
    note: review.note,
    source: { id: 'demo-balance', label: 'Demo balance' },
    reviewDigest: review.digest,
    expiresAt: review.expires_at.toISOString(),
    mode: 'demo',
  };
}

export async function getOperation(
  principal: Principal,
  id: string,
  db: ReadDatabase = database(),
): Promise<Operation> {
  const operation = await db
    .selectFrom('operations as operation')
    .leftJoin('payment_requests as request', 'request.id', 'operation.request_id')
    .selectAll('operation')
    .select('request.expense_id')
    .where('operation.workspace_id', '=', principal.workspaceId)
    .where('operation.id', '=', id)
    .where((eb) =>
      eb.or([
        eb('operation.payer_id', '=', principal.personId),
        eb('operation.payee_id', '=', principal.personId),
      ]),
    )
    .executeTakeFirst();
  if (!operation) notFound();
  const person = indexedPeople(await getPeople(principal, db));
  return {
    id: operation.id,
    status: operation.status,
    kind: operation.kind,
    amountMinor: operation.amount_minor,
    currency: 'USD',
    from: person(operation.payer_id),
    to: person(operation.payee_id),
    requestId: operation.request_id,
    expenseId: operation.expense_id,
    note: operation.note,
    createdAt: operation.created_at.toISOString(),
    completedAt: operation.completed_at?.toISOString() ?? null,
    mode: 'demo',
  };
}
