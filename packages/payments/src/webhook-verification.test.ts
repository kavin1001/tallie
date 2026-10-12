import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATURAL_WEBHOOK_MAX_BYTES,
  readNaturalWebhookBody,
  verifyNaturalEvent,
} from './webhook-verification';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const id = `evt_${'1'.repeat(32)}`;
const resourceId = `pay_${'2'.repeat(32)}`;
const body = Buffer.from(
  JSON.stringify({
    id,
    object: 'event',
    type: 'payment.completed',
    sourcePartyId: `pty_${'3'.repeat(32)}`,
    resourceType: 'payment',
    resourceId,
    createdAt: new Date().toISOString(),
    data: { object: { id: resourceId, type: 'payment' } },
  }),
);
function signed(raw = body, signedAt = new Date(), key = secret, eventId = id) {
  return new Headers({
    'webhook-id': eventId,
    'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
    'webhook-signature': new Webhook(key).sign(eventId, signedAt, raw),
  });
}
afterEach(() => vi.useRealTimers());
describe('Natural Standard Webhooks verification', () => {
  it('authenticates the exact body and preserves its bytes', () => {
    const result = verifyNaturalEvent(body, signed(), [secret]);
    expect(result.event.id).toBe(id);
    expect(result.rawBody).toEqual(body);
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects changed body bytes, signed ID, and a different secret', () => {
    expect(() =>
      verifyNaturalEvent(Buffer.concat([body, Buffer.from(' ')]), signed(), [secret]),
    ).toThrow('INVALID_WEBHOOK_SIGNATURE');
    const headers = signed();
    headers.set('webhook-id', `evt_${'4'.repeat(32)}`);
    expect(() => verifyNaturalEvent(body, headers, [secret])).toThrow('INVALID_WEBHOOK_SIGNATURE');
    expect(() =>
      verifyNaturalEvent(body, signed(), [`whsec_${randomBytes(32).toString('base64')}`]),
    ).toThrow('INVALID_WEBHOOK_SIGNATURE');
  });
  it.each([-301000, 301000])('rejects deliveries outside the replay window (%i)', (offset) => {
    expect(() =>
      verifyNaturalEvent(body, signed(body, new Date(Date.now() + offset)), [secret]),
    ).toThrow('INVALID_WEBHOOK_SIGNATURE');
  });
  it('supports provider overlapping signatures and old/new configuration keys', () => {
    const next = `whsec_${randomBytes(32).toString('base64')}`;
    const headers = signed();
    headers.set(
      'webhook-signature',
      `${signed(body, new Date(), next).get('webhook-signature')} ${headers.get('webhook-signature')}`,
    );
    expect(verifyNaturalEvent(body, headers, [secret]).event.id).toBe(id);
    expect(verifyNaturalEvent(body, headers, [next]).event.id).toBe(id);
    expect(verifyNaturalEvent(body, signed(), [next, secret]).event.id).toBe(id);
  });
  it('rejects ambiguous timestamp/header formats', () => {
    for (const value of ['0012345678', '1234567890x', '1234567890,1234567890']) {
      const headers = signed();
      headers.set('webhook-timestamp', value);
      expect(() => verifyNaturalEvent(body, headers, [secret])).toThrow(
        'INVALID_WEBHOOK_SIGNATURE',
      );
    }
    const headers = signed();
    headers.set('webhook-signature', 'v1,' + 'a'.repeat(2048));
    expect(() => verifyNaturalEvent(body, headers, [secret])).toThrow('INVALID_WEBHOOK_SIGNATURE');
  });
  it('requires matching signed body and header event IDs and resource IDs', () => {
    expect(() =>
      verifyNaturalEvent(body, signed(body, new Date(), secret, `evt_${'9'.repeat(32)}`), [secret]),
    ).toThrow('INVALID_WEBHOOK_EVENT');
    const event = JSON.parse(body.toString());
    event.data.object.id = `pay_${'9'.repeat(32)}`;
    const raw = Buffer.from(JSON.stringify(event));
    expect(() => verifyNaturalEvent(raw, signed(raw), [secret])).toThrow('INVALID_WEBHOOK_EVENT');
  });
  it('rejects malformed JSON and non-UTF8 bytes even with a matching signature', () => {
    for (const raw of [Buffer.from('{'), Buffer.from([0xc0, 0xaf])])
      expect(() => verifyNaturalEvent(raw, signed(raw), [secret])).toThrow('INVALID_WEBHOOK_BODY');
  });
  it('requires strong well-formed configured signing secrets', () => {
    for (const keys of [[], ['abc'], ['whsec_YQ=='], [secret, secret, secret]])
      expect(() => verifyNaturalEvent(body, signed(), keys)).toThrow(
        'NATURAL_WEBHOOK_NOT_CONFIGURED',
      );
  });
});
describe('bounded webhook body', () => {
  function request(value: BodyInit, headers: Record<string, string> = {}) {
    return new Request('https://example.test', {
      method: 'POST',
      body: value,
      headers,
      duplex: 'half',
    } as RequestInit);
  }
  it('preserves whitespace and rejects lying Content-Length', async () => {
    const value = '  {"value": 1}\n';
    expect(await readNaturalWebhookBody(request(value))).toEqual(Buffer.from(value));
    await expect(readNaturalWebhookBody(request(value, { 'content-length': '1' }))).rejects.toThrow(
      'INVALID_WEBHOOK_BODY',
    );
  });
  it('bounds declared and streamed bytes', async () => {
    await expect(
      readNaturalWebhookBody(
        request('x', { 'content-length': String(NATURAL_WEBHOOK_MAX_BYTES + 1) }),
      ),
    ).rejects.toThrow('WEBHOOK_BODY_TOO_LARGE');
    await expect(
      readNaturalWebhookBody(request('x'.repeat(NATURAL_WEBHOOK_MAX_BYTES + 1))),
    ).rejects.toThrow('WEBHOOK_BODY_TOO_LARGE');
  });
  it('cancels an indefinitely stalled stream within ten seconds', async () => {
    vi.useFakeTimers();
    let canceled = false;
    const promise = readNaturalWebhookBody(
      request(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
    const assertion = expect(promise).rejects.toThrow('WEBHOOK_BODY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    expect(canceled).toBe(true);
  });
});
