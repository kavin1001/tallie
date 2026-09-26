/**
 * Independent HTTP integration checks against the local simulator.
 * Run the web app + worker + migrated PostgreSQL first, then:
 *   npx tsx scripts/verify-api.ts
 * Creates isolated demo workspaces. It never contacts payment providers.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ApiResponse,
  CreateExpenseInput,
  Dashboard,
  ExpenseSummary,
  Operation,
  PaymentReview,
} from '../packages/db/src/contracts';

const base = new URL(process.env.TALLIE_VERIFY_ORIGIN ?? 'http://localhost:3000');
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
  'Verification is restricted to a local simulator.',
);
assert(base.protocol === 'http:', 'Use the local HTTP simulator.');

type Result<T> = { status: number; headers: Headers; body: ApiResponse<T> };

class Browser {
  cookie = '';

  async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      key?: string;
      origin?: string | null;
      contentType?: string;
    } = {},
  ): Promise<Result<T>> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (method === 'POST') {
      if (options.origin !== null) headers.Origin = options.origin ?? base.origin;
      headers['Content-Type'] = options.contentType ?? 'application/json';
    }
    if (options.key) headers['Idempotency-Key'] = options.key;
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.includes('_demo_session='));
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const body = (await response.json()) as ApiResponse<T>;
    return { status: response.status, headers: response.headers, body };
  }

  async post<T>(path: string, body: unknown = {}, key?: string): Promise<Result<T>> {
    return this.request<T>(path, { method: 'POST', body, ...(key ? { key } : {}) });
  }
}

function data<T>(result: Result<T>, allowedStatuses: readonly number[] = [200]): T {
  assert(
    allowedStatuses.includes(result.status),
    `Expected ${allowedStatuses.join('/')} but received ${result.status}: ${JSON.stringify(result.body)}`,
  );
  assert('data' in result.body, 'Successful response must contain data.');
  return result.body.data;
}

function rejected(result: Result<unknown>, statuses: readonly number[]): void {
  assert(
    statuses.includes(result.status),
    `Expected rejection ${statuses.join('/')} but received ${result.status}: ${JSON.stringify(result.body)}`,
  );
  assert(
    'error' in result.body && typeof result.body.error.code === 'string',
    'Rejected request needs a stable error code.',
  );
}

let checkCount = 0;
function checked(message: string): void {
  checkCount += 1;
  process.stdout.write(`PASS ${message}\n`);
}

async function complete(browser: Browser, operationId: string): Promise<Operation> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const operation = data(await browser.request<Operation>(`/api/operations/${operationId}`));
    if (operation.status === 'completed') return operation;
    assert(
      ['queued', 'processing'].includes(operation.status),
      'Simulator operation unexpectedly failed.',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Operation did not complete within 20 seconds. Is the simulator worker running?');
}

async function main(): Promise<void> {
  const anonymous = new Browser();
  rejected(await anonymous.request('/api/dashboard'), [401]);
  rejected(
    await anonymous.request('/api/demo/session', {
      method: 'POST',
      origin: 'https://untrusted.example',
    }),
    [403],
  );
  rejected(await anonymous.request('/api/demo/session', { method: 'POST', origin: null }), [403]);
  checked('Anonymous reads and cross-origin or missing-origin mutations are rejected.');

  const alice = new Browser();
  const bob = new Browser();
  const aliceBootstrap = await alice.post<Dashboard>('/api/demo/session');
  const aliceInitial = data(aliceBootstrap, [200, 201]);
  const bobInitial = data(await bob.post<Dashboard>('/api/demo/session'), [200, 201]);
  assert.equal(aliceInitial.mode, 'demo');
  assert.notEqual(aliceInitial.user.id, bobInitial.user.id);
  assert(
    aliceInitial.people.every(
      (person) => !bobInitial.people.some((other) => other.id === person.id),
    ),
  );
  assert(
    alice.cookie.length > 32 && bob.cookie.length > 32,
    'Each browser needs its own opaque cookie.',
  );
  const cookieHeader = aliceBootstrap.headers.getSetCookie().join(';').toLowerCase();
  assert(cookieHeader.includes('httponly') && cookieHeader.includes('samesite=strict'));
  checked(
    'Separate visitors receive distinct private demo datasets and HttpOnly SameSite cookies.',
  );

  const dashboardResponse = await alice.request<Dashboard>('/api/dashboard');
  assert.match(dashboardResponse.headers.get('cache-control') ?? '', /no-store/);
  assert.match(dashboardResponse.headers.get('cache-control') ?? '', /private/);
  const capabilities = data(dashboardResponse).capabilities;
  for (const name of ['natural', 'imessage', 'venmo'] as const)
    assert.equal(capabilities[name], false);
  assert.equal(typeof capabilities.receiptUpload, 'boolean');
  assert.equal(typeof capabilities.phoneVerification, 'boolean');
  checked('Private responses are not cacheable and unsupported live capabilities are disabled.');

  const original = aliceInitial.user;
  const friend = aliceInitial.people.find((person) => person.id !== original.id);
  assert(friend, 'Fixture needs a friend.');
  const expenseInput: CreateExpenseInput = {
    title: 'Independent concurrency check',
    emoji: '🧪',
    category: 'other',
    totalMinor: '1001',
    participantIds: [original.id, friend.id],
    method: 'equal',
  };

  rejected(
    await alice.post(
      '/api/expenses',
      { ...expenseInput, actorId: bobInitial.user.id },
      randomUUID(),
    ),
    [400],
  );
  rejected(
    await alice.post('/api/expenses', { ...expenseInput, totalMinor: 1001 }, randomUUID()),
    [400],
  );
  rejected(
    await alice.post('/api/expenses', { ...expenseInput, totalMinor: 'not-money' }, randomUUID()),
    [400],
  );
  rejected(
    await alice.post('/api/expenses', { ...expenseInput, totalMinor: '10.01' }, randomUUID()),
    [400],
  );
  rejected(
    await alice.post(
      '/api/expenses',
      { ...expenseInput, participantIds: [original.id, original.id] },
      randomUUID(),
    ),
    [400, 422],
  );
  rejected(
    await alice.post(
      '/api/expenses',
      { ...expenseInput, participantIds: [original.id, bobInitial.user.id] },
      randomUUID(),
    ),
    [400, 403, 404],
  );
  rejected(await alice.post('/api/demo/persona', { personId: bobInitial.user.id }), [403, 404]);
  checked(
    'Strict schemas reject actor injection, numeric cents, duplicate identities, and foreign-workspace participants.',
  );

  const expenseKey = randomUUID();
  const concurrentExpenseResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      alice.post<ExpenseSummary>('/api/expenses', expenseInput, expenseKey),
    ),
  );
  const expenses = concurrentExpenseResults.map((result) => data(result, [200, 201]));
  const expense = expenses[0];
  assert(expense);
  assert(
    expenses.every((item) => item.id === expense.id),
    'Concurrent duplicate creates must return the same expense.',
  );
  assert.equal(
    expense.participants.reduce((sum, share) => sum + BigInt(share.amountMinor), 0n),
    1001n,
  );
  assert.equal(expense.participants.filter((share) => share.requestId !== null).length, 1);
  const self = expense.participants.find((share) => share.person.id === original.id);
  assert.equal(self?.status, 'self');
  assert.equal(self.requestId, null);
  rejected(
    await alice.post(
      '/api/expenses',
      { ...expenseInput, title: 'Changed immutable command' },
      expenseKey,
    ),
    [409],
  );
  checked(
    'Eight concurrent expense submissions create one conserved split; changed idempotent payloads conflict.',
  );

  const share = expense.participants.find((item) => item.person.id === friend.id);
  assert(share?.requestId);
  const requestId = share.requestId;
  rejected(await bob.post(`/api/requests/${requestId}/review`), [403, 404]);
  rejected(await alice.post(`/api/requests/${requestId}/review`), [403, 404, 409]);
  checked('An unrelated workspace and the requester cannot authorize the debtor’s request.');

  const oldSession = new Browser();
  oldSession.cookie = alice.cookie;
  const payerDashboard = data(
    await alice.post<Dashboard>('/api/demo/persona', { personId: friend.id }),
  );
  assert.equal(payerDashboard.user.id, friend.id);
  rejected(await oldSession.request('/api/dashboard'), [401]);
  rejected(
    await alice.post(`/api/requests/${requestId}/cancel`, { expectedVersion: 1 }),
    [403, 404],
  );
  checked(
    'Persona switching rotates/revokes session tokens and debtors cannot cancel another person’s request.',
  );

  const review = data(
    await alice.post<PaymentReview>(`/api/requests/${requestId}/review`),
    [200, 201],
  );
  const competingReview = data(
    await alice.post<PaymentReview>(`/api/requests/${requestId}/review`),
    [200, 201],
  );
  assert.equal(review.amountMinor, share.amountMinor);
  assert.equal(review.from.id, friend.id);
  assert.equal(review.to.id, original.id);
  assert.equal(review.mode, 'demo');
  rejected(
    await alice.post(
      `/api/payment-reviews/${review.id}/authorize`,
      { reviewDigest: '0'.repeat(64) },
      randomUUID(),
    ),
    [400, 409],
  );
  rejected(
    await alice.post(
      `/api/payment-reviews/${review.id}/authorize`,
      { reviewDigest: review.reviewDigest, amountMinor: '1' },
      randomUUID(),
    ),
    [400],
  );
  checked(
    'Review binds the canonical payer, destination, amount, and digest; tampering is rejected.',
  );

  const paymentKey = randomUUID();
  const paymentResults = await Promise.all(
    Array.from({ length: 10 }, () =>
      alice.post<Operation>(
        `/api/payment-reviews/${review.id}/authorize`,
        { reviewDigest: review.reviewDigest },
        paymentKey,
      ),
    ),
  );
  const operations = paymentResults.map((result) => data(result, [200, 202]));
  const operation = operations[0];
  assert(operation);
  assert(
    operations.every((item) => item.id === operation.id),
    'Concurrent payment submissions must return one operation.',
  );
  assert.equal(operation.amountMinor, share.amountMinor);
  assert.equal(operation.mode, 'demo');
  const secondAttempt = await alice.post<Operation>(
    `/api/payment-reviews/${competingReview.id}/authorize`,
    { reviewDigest: competingReview.reviewDigest },
    randomUUID(),
  );
  rejected(secondAttempt, [409]);
  rejected(await bob.request(`/api/operations/${operation.id}`), [403, 404]);
  checked(
    'Ten concurrent approvals reserve one operation; competing reviews and cross-workspace reads are rejected.',
  );

  const completed = await complete(alice, operation.id);
  assert.equal(completed.amountMinor, share.amountMinor);
  const paidDashboard = data(await alice.request<Dashboard>('/api/dashboard'));
  assert.equal(paidDashboard.requests.find((request) => request.id === requestId)?.status, 'paid');
  assert.equal(
    paidDashboard.activity.filter(
      (activity) => activity.operationId === operation.id && activity.type === 'payment_sent',
    ).length,
    1,
  );
  const replay = data(
    await alice.post<Operation>(
      `/api/payment-reviews/${review.id}/authorize`,
      { reviewDigest: review.reviewDigest },
      paymentKey,
    ),
    [200, 202],
  );
  assert.equal(replay.id, operation.id);
  assert.equal(replay.status, 'completed');
  checked(
    'Worker completion is authoritative, journals one visible effect, and post-completion replay returns the original operation.',
  );

  const returned = data(
    await alice.post<Dashboard>('/api/demo/persona', { personId: original.id }),
  );
  assert.equal(
    returned.activity.filter(
      (activity) => activity.operationId === operation.id && activity.type === 'payment_received',
    ).length,
    1,
  );
  assert.equal(returned.expenses.filter((item) => item.id === expense.id).length, 1);
  assert.equal(returned.expenses.find((item) => item.id === expense.id)?.status, 'settled');
  checked(
    'The requester sees one received effect and a settled expense after the other participant pays.',
  );

  const directReview = data(
    await alice.post<PaymentReview>('/api/sends/review', {
      recipientId: friend.id,
      amountMinor: '123',
      note: 'Independent direct-send check',
    }),
    [200, 201],
  );
  const directOperation = data(
    await alice.post<Operation>(
      `/api/payment-reviews/${directReview.id}/authorize`,
      {
        reviewDigest: directReview.reviewDigest,
      },
      randomUUID(),
    ),
    [200, 202],
  );
  assert.equal(directOperation.kind, 'send');
  assert.equal(directOperation.requestId, null);
  assert.equal((await complete(alice, directOperation.id)).amountMinor, '123');
  checked(
    'Direct sends use their own explicit immutable review and complete independently of expense debts.',
  );

  if (process.env.TALLIE_VERIFY_VOLUME === '1') {
    const before = data(await alice.request<Dashboard>('/api/dashboard'));
    const participantIds = before.people.map((person) => person.id);
    assert.equal(participantIds.length, 5, 'This volume fixture expects five demo people.');
    // More than 200 outgoing requests exercises aggregation beyond the list page.
    for (let batch = 0; batch < 13; batch += 1) {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, offset) =>
          alice.post<ExpenseSummary>(
            '/api/expenses',
            {
              title: `Pagination invariant ${batch * 4 + offset + 1}`,
              emoji: '🧮',
              category: 'other',
              totalMinor: '10000',
              participantIds,
              method: 'equal',
            },
            randomUUID(),
          ),
        ),
      );
      for (const result of results) data(result, [200, 201]);
    }
    const after = data(await alice.request<Dashboard>('/api/dashboard'));
    assert.equal(
      BigInt(after.summary.owedToYouMinor),
      BigInt(before.summary.owedToYouMinor) + 52n * 8000n,
      'Financial summary must aggregate all obligations, independently of display pagination.',
    );
    checked(
      'Balances remain exact after more than 200 requests, independently of list pagination.',
    );
  }

  process.stdout.write(
    `\n${checkCount} independent local HTTP integration groups passed. No real money moved.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
