import { createHash } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';

export const NATURAL_WEBHOOK_MAX_BYTES = 256 * 1024;
const eventId = /^evt_[a-f0-9]{32}$/;
const partyId = /^pty_[a-f0-9]{32}$/;
const resourceId = /^[a-zA-Z][a-zA-Z0-9]*_[a-f0-9]{32}$/;
const envelope = z.object({
  id: z.string().regex(eventId),
  object: z.literal('event'),
  type: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/)
    .max(100),
  sourcePartyId: z.string().regex(partyId),
  resourceType: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
    .max(50),
  resourceId: z.string().regex(resourceId),
  createdAt: z.iso.datetime({ offset: true }),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export class NaturalWebhookError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'NaturalWebhookError';
  }
}

export type VerifiedNaturalEvent = Readonly<{
  event: z.infer<typeof envelope>;
  rawBody: Buffer;
  payloadHash: string;
  signedAt: Date;
}>;

export function validateNaturalWebhookSecret(secret: string): void {
  const encoded = secret.slice(6);
  if (
    !secret.startsWith('whsec_') ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    encoded.length > 256 ||
    Buffer.from(encoded, 'base64').length < 32 ||
    Buffer.from(encoded, 'base64').toString('base64') !== encoded
  )
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
}

/** Official Standard Webhooks contract: exact UTF-8 bytes, five-minute replay
 * window, and any matching v1 signature during provider secret rotation. */
export function verifyNaturalEvent(
  rawBody: Buffer,
  headers: Headers,
  secrets: readonly string[],
): VerifiedNaturalEvent {
  if (!secrets.length || secrets.length > 2)
    throw new NaturalWebhookError('NATURAL_WEBHOOK_NOT_CONFIGURED', 503);
  secrets.forEach(validateNaturalWebhookSecret);
  if (!rawBody.length || rawBody.length > NATURAL_WEBHOOK_MAX_BYTES)
    throw new NaturalWebhookError('INVALID_WEBHOOK_BODY', rawBody.length ? 413 : 400);
  const id = headers.get('webhook-id') ?? '';
  const timestamp = headers.get('webhook-timestamp') ?? '';
  const signature = headers.get('webhook-signature') ?? '';
  if (
    !eventId.test(id) ||
    !/^[1-9][0-9]{9}$/.test(timestamp) ||
    !signature ||
    signature.length > 2048
  )
    throw new NaturalWebhookError('INVALID_WEBHOOK_SIGNATURE', 401);
  // The vetted verifier converts Buffer to UTF-8. Reject malformed bytes rather
  // than accepting a signature over replacement characters or altered encoding.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    throw new NaturalWebhookError('INVALID_WEBHOOK_BODY');
  }
  let authenticated = false;
  for (const secret of secrets) {
    try {
      new Webhook(secret).verify(
        rawBody,
        {
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
        },
        { jsonParse: false },
      );
      authenticated = true;
      break;
    } catch {
      /* Other valid rotation key may verify; never log headers/body. */
    }
  }
  if (!authenticated) throw new NaturalWebhookError('INVALID_WEBHOOK_SIGNATURE', 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new NaturalWebhookError('INVALID_WEBHOOK_BODY');
  }
  const result = envelope.safeParse(parsed);
  if (!result.success || result.data.id !== id)
    throw new NaturalWebhookError('INVALID_WEBHOOK_EVENT');
  const event = result.data;
  const invitation = event.resourceType === 'agent_delegation_invitation';
  const objectId = invitation ? event.data.object.invitationId : event.data.object.id;
  // Invitation snapshots use invitationId, not id. Future resource envelopes may
  // omit either; they remain quarantined and never reach financial processing.
  const requiresObjectId = invitation || ['payment', 'transfer'].includes(event.resourceType);
  if ((requiresObjectId || objectId !== undefined) && objectId !== event.resourceId)
    throw new NaturalWebhookError('INVALID_WEBHOOK_EVENT');
  return {
    event: result.data,
    rawBody,
    payloadHash: createHash('sha256').update(rawBody).digest('hex'),
    signedAt: new Date(Number(timestamp) * 1000),
  };
}

export async function readNaturalWebhookBody(request: Request): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > NATURAL_WEBHOOK_MAX_BYTES))
    throw new NaturalWebhookError('WEBHOOK_BODY_TOO_LARGE', 413);
  if (!request.body) throw new NaturalWebhookError('INVALID_WEBHOOK_BODY');
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 10_000);
  let complete = false;
  try {
    while (true) {
      const value = await reader.read();
      if (timedOut) throw new NaturalWebhookError('WEBHOOK_BODY_TIMEOUT', 408);
      if (value.done) {
        complete = true;
        break;
      }
      size += value.value.length;
      if (size > NATURAL_WEBHOOK_MAX_BYTES)
        throw new NaturalWebhookError('WEBHOOK_BODY_TOO_LARGE', 413);
      chunks.push(Buffer.from(value.value));
    }
    // Missing/truncated Content-Length bodies must not enter signature parsing.
    if (!size || (length !== null && size !== Number(length)))
      throw new NaturalWebhookError('INVALID_WEBHOOK_BODY');
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
