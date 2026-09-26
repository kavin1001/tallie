import { z } from 'zod';

const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value),
    'Use ordinary text without hidden formatting.',
  );
const minor = z
  .string()
  .regex(/^(0|[1-9]\d{0,7})$/)
  .refine((value) => BigInt(value) <= 10000000n);
// PostgreSQL canonicalizes UUIDs; keep string-based participant matching identical.
const uuid = z.uuid().transform((value) => value.toLowerCase());
export const contactInput = z
  .object({
    label: label.pipe(z.string().max(80)),
    phone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/, 'Enter a US phone number including +1.'),
  })
  .strict();
export const expenseInput = z
  .object({
    title: label,
    emoji: z.string().min(1).max(16),
    category: z.enum(['dinner', 'travel', 'coffee', 'groceries', 'tickets', 'other']),
    totalMinor: minor.refine((value) => BigInt(value) > 0n),
    participantIds: z.array(uuid).min(2).max(20),
    method: z.enum(['equal', 'items', 'custom']),
    shares: z
      .array(z.object({ participantId: uuid, amountMinor: minor }).strict())
      .max(20)
      .optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: label,
            amountMinor: minor,
            participantIds: z.array(uuid).min(1).max(20),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    taxMinor: minor.optional(),
    tipMinor: minor.optional(),
    discountMinor: minor.optional(),
  })
  .strict();
export const invitationInput = z.object({ contactId: uuid, expenseId: uuid.optional() }).strict();
export const tokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const emptyInput = z.object({}).strict();

export class SocialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/** Stable object-key order binds retries to the same semantic request. Arrays remain ordered. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
