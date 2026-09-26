import { createHash } from 'node:crypto';
import { allocateEqual } from '@tallie/domain';
import type { MessageDraft, MessageMethod } from './contracts';

export type MessageIntent =
  | { type: 'method'; method: MessageMethod }
  | { type: 'participants'; names: string[] }
  | { type: 'split'; totalMinor: string; names: string[]; title: string }
  | { type: 'confirm'; token: string }
  | { type: 'payment' | 'help' | 'review' | 'new' | 'unknown' };

function namesFrom(text: string): string[] {
  const names = text
    .split(/\s+(?:and|&)\s+|,\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    names.length > 19 ||
    names.some((name) => name.length > 60 || /[\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(name))
  )
    return [];
  return [...new Set(names)];
}

/** A deliberately small, auditable grammar. Receipt text never enters this parser. */
export function parseIntent(content: string): MessageIntent {
  const text = content.trim();
  if (/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(text)) return { type: 'unknown' };
  const choice = text
    .replace(/[,\s]+(?:please|thanks)(?:[.!\s✨]*)$/i, '')
    .replace(/[.!\s✨]+$/, '');
  if (/^(?:pay|approve|send money|yes pay|✅)(?:\s|$)/i.test(text)) return { type: 'payment' };
  if (/^(?:equal|equally|evenly|split equally|split evenly)$/i.test(choice))
    return { type: 'method', method: 'equal' };
  if (/^(?:items|by item|itemized)$/i.test(choice)) return { type: 'method', method: 'items' };
  if (/^(?:custom|custom amounts)$/i.test(choice)) return { type: 'method', method: 'custom' };
  if (/^(?:help|hi(?: tallie)?|hello(?: tallie)?)$/i.test(choice)) return { type: 'help' };
  if (/^(?:review|ready|done)$/i.test(text)) return { type: 'review' };
  if (/^(?:new|new split|start over)$/i.test(text)) return { type: 'new' };
  const confirm = /^confirm ([a-f0-9]{12})$/i.exec(text);
  if (confirm?.[1]) return { type: 'confirm', token: confirm[1].toLowerCase() };
  const people = /^(?:with|participants|friends)\s+(.+)$/i.exec(text);
  if (people?.[1]) return { type: 'participants', names: namesFrom(people[1]) };
  const split =
    /^split\s+\$?([0-9]{1,6}(?:\.[0-9]{1,2})?)(?:\s+for\s+(.{1,80}?))?\s+with\s+(.+)$/i.exec(text);
  if (split?.[1] && split[3]) {
    const [whole = '0', fractional = ''] = split[1].split('.');
    const total = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
    if (total > 0n && total <= 10_000_000n)
      return {
        type: 'split',
        totalMinor: total.toString(),
        title: split[2]?.trim() ?? 'Shared moment',
        names: namesFrom(split[3]),
      };
  }
  return { type: 'unknown' };
}

export function draftReviewDigest(draft: MessageDraft, payerId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: draft.id,
        version: draft.version,
        title: draft.title,
        totalMinor: draft.totalMinor,
        method: draft.method,
        participants: [payerId, ...draft.participants.map((p) => p.personId)].sort(),
      }),
    )
    .digest('hex');
}

export function equalReviewText(draft: MessageDraft, payerId: string): string {
  if (!draft.totalMinor || !draft.reviewDigest) throw new Error('Incomplete message review.');
  const people = [{ personId: payerId, name: 'You' }, ...draft.participants];
  const total = BigInt(draft.totalMinor);
  const amount = (cents: bigint) =>
    `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  const shares = allocateEqual(
    total,
    people.map((person) => person.personId),
  ).map(
    (share) =>
      `${people.find((person) => person.personId === share.participantId)!.name}: ${amount(share.amountMinor)}`,
  );
  return `${draft.title} · ${amount(total)} total\nEqual split\n${shares.join('\n')}\n\nYou paid the original bill. Reply CONFIRM ${draft.reviewDigest.slice(0, 12)} within 5 minutes to create these requests. This does not pay anyone.`;
}
