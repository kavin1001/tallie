import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MessagingError, type InboundMessage } from './contracts';

export const phoneSchema = z.string().regex(/^\+1[2-9]\d{9}$/);
export const handleSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const nullableText = z.string().max(2048).nullish();
const eventSchema = z.object({
  message_handle: handleSchema,
  from_number: phoneSchema,
  to_number: phoneSchema,
  sendblue_number: phoneSchema.nullish(),
  content: z.string().max(8000).nullish(),
  media_url: nullableText,
  is_outbound: z.boolean(),
  status: z.string().max(32),
  date_sent: z.iso.datetime({ offset: true }),
  date_updated: z.iso.datetime({ offset: true }).optional(),
  message_type: z.enum(['message', 'group']),
  group_id: z.string().max(200).nullish(),
  participants: z.array(phoneSchema).max(25).optional(),
  opted_out: z.boolean().optional(),
  reply_to: z.object({ message_handle: handleSchema }).nullish(),
});

export function verifyMessageWebhook(header: string | null, expected: string): boolean {
  if (expected.length < 32 || !header || header.length > 256) return false;
  return timingSafeEqual(
    createHash('sha256').update(header).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

export function normalizeMessage(value: unknown, expectedLine: string): InboundMessage {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw new MessagingError('INVALID_MESSAGE_EVENT');
  const event = parsed.data;
  const line = event.is_outbound ? event.from_number : event.to_number;
  if (line !== expectedLine || (event.sendblue_number && event.sendblue_number !== line))
    throw new MessagingError('WRONG_RECEIVING_LINE', 403);
  const occurredAt = new Date(event.date_sent);
  if (occurredAt > new Date(Date.now() + 5 * 60_000))
    throw new MessagingError('MESSAGE_FROM_FUTURE');
  return {
    handle: event.message_handle,
    from: event.is_outbound ? event.to_number : event.from_number,
    line,
    content: event.content ?? '',
    mediaUrl: event.media_url || null,
    occurredAt: occurredAt.toISOString(),
    updatedAt: new Date(event.date_updated ?? event.date_sent).toISOString(),
    outbound: event.is_outbound,
    status: event.status.toUpperCase(),
    group:
      event.message_type === 'group' || !!event.group_id || (event.participants?.length ?? 0) > 2,
    optedOut: event.opted_out ?? false,
    replyTo: event.reply_to?.message_handle ?? null,
  };
}

export function canonicalMessageMatches(a: InboundMessage, b: InboundMessage): boolean {
  return (
    a.handle === b.handle &&
    a.from === b.from &&
    a.line === b.line &&
    a.content === b.content &&
    a.mediaUrl === b.mediaUrl &&
    a.outbound === b.outbound &&
    a.group === b.group &&
    a.occurredAt === b.occurredAt &&
    a.replyTo === b.replyTo
  );
}

export function messageHash(message: InboundMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

export function optCommand(content: string): 'stop' | 'start' | null {
  const command = content
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (['stop', 'unsubscribe', 'cancel', 'opt out', 'revoke', 'end', 'quit'].includes(command))
    return 'stop';
  return command === 'start' ? 'start' : null;
}

export async function readBoundedBody(request: Request, maximum = 65_536): Promise<Buffer> {
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new MessagingError('PAYLOAD_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new MessagingError('PAYLOAD_TOO_LARGE', 413);
      }
      chunks.push(next.value);
    }
  }
  return Buffer.concat(chunks);
}
