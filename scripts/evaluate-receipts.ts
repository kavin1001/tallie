import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ReceiptDraft } from '@tallie/receipts/contracts';

// Deliberately opt-in: this runs three synthetic images through the live worker.
if (!process.argv.includes('--live-synthetic'))
  throw new Error(
    'Pass --live-synthetic to allow three fixture uploads and their bounded provider attempts.',
  );
const origin = 'http://localhost:3000';
let cookie = '';
async function request(path: string, body?: unknown, key?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
}
const session = await request('/api/demo/session', {});
assert.equal(session.status, 201);
cookie = session.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
const dataset = JSON.parse(
  await readFile(resolve('packages/receipts/fixtures/expected.json'), 'utf8'),
);
const results = [];
for (const fixture of dataset.fixtures) {
  const start = Date.now();
  const response = await request(
    '/api/receipts',
    {
      contentBase64: (
        await readFile(resolve('packages/receipts/fixtures', fixture.image))
      ).toString('base64'),
      contentType: 'image/png',
    },
    randomUUID(),
  );
  assert.equal(response.status, 202);
  let draft: ReceiptDraft = (await response.json()).data;
  while (['queued', 'processing'].includes(draft.status) && Date.now() - start < 150_000) {
    await new Promise((done) => setTimeout(done, 1500));
    const status = await request(`/api/receipts/${draft.id}`);
    assert.equal(status.status, 200);
    draft = (await status.json()).data;
  }
  assert.equal(
    draft.status,
    'review_needed',
    `Fixture ${fixture.id} ended in ${draft.status}: ${draft.error?.code ?? 'no error code'}`,
  );
  const proposal = draft.proposal!;
  const expected = fixture.expected;
  const checks: Record<string, boolean> = {
    currency: proposal.currency === expected.currency,
    total: proposal.totalMinor === expected.statedTotalMinor,
    subtotal: proposal.subtotalMinor === expected.subtotalMinor,
    tax: proposal.taxMinor === expected.taxMinor,
    tip: proposal.tipMinor === expected.tipMinor,
    lineTotals:
      JSON.stringify(proposal.items.map((item) => item.amountMinor)) ===
      JSON.stringify(
        expected.items.map((item: { lineAmountMinor: string }) => item.lineAmountMinor),
      ),
    noForbiddenText: (fixture.forbiddenOutputFragments ?? []).every(
      (fragment: string) =>
        !JSON.stringify(proposal).toLowerCase().includes(fragment.toLowerCase()),
    ),
  };
  const imageResponse = await request(`/api/receipts/${draft.id}/image`);
  checks.privatePreview =
    imageResponse.status === 200 &&
    /private/.test(imageResponse.headers.get('cache-control') ?? '');
  await imageResponse.body?.cancel();
  const anonymous = await fetch(`${origin}/api/receipts/${draft.id}/image`);
  checks.anonymousBlocked = anonymous.status === 401;
  await anonymous.body?.cancel();
  results.push({ fixture: fixture.id, elapsedMs: Date.now() - start, checks, proposal });
  console.log(JSON.stringify({ fixture: fixture.id, checks, elapsedMs: Date.now() - start }));
}
await mkdir('.tallie', { recursive: true });
await writeFile(
  '.tallie/receipt-evaluation.json',
  JSON.stringify({ evaluatedAt: new Date().toISOString(), syntheticOnly: true, results }, null, 2),
);
assert(
  results.every((row) => Object.values(row.checks).every(Boolean)),
  'One or more extraction smoke checks failed. Inspect the synthetic-only result artifact.',
);
console.log(
  'Three live synthetic receipt evaluations passed. This is not a real-world accuracy or redaction evaluation.',
);
