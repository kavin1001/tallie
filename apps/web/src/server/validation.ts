import { z } from 'zod';
import { AppError } from './errors';

export const identifier = z.uuid();
export function parseIdentifier(value: string): string {
  const result = identifier.safeParse(value);
  if (!result.success) throw new AppError('NOT_FOUND', 'This item is not available.', 404);
  return result.data;
}
export const cents = z
  .string()
  .regex(/^(0|[1-9]\d{0,7})$/, 'Use a whole number of cents.')
  .refine((value) => value === value.trim(), 'Use a canonical whole number of cents.')
  .pipe(
    z
      .string()
      .refine((value) => BigInt(value) <= 10_000_000n, 'The demo limit is $100,000 per split.'),
  );
const positiveCents = cents.pipe(
  z.string().refine((value) => BigInt(value) > 0n, 'Enter an amount above zero.'),
);
const label = z.string().trim().min(1).max(100);
const participantIds = z
  .array(identifier)
  .min(2)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'Each person can appear once.');

export const createExpenseSchema = z
  .object({
    title: label,
    emoji: z.string().trim().min(1).max(16),
    category: z.enum(['dinner', 'travel', 'coffee', 'groceries', 'tickets', 'other']),
    totalMinor: positiveCents,
    participantIds,
    method: z.enum(['equal', 'custom', 'items']),
    shares: z
      .array(z.object({ participantId: identifier, amountMinor: cents }).strict())
      .max(20)
      .optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: label,
            amountMinor: cents,
            participantIds: z.array(identifier).min(1).max(20),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    taxMinor: cents.optional(),
    tipMinor: cents.optional(),
    discountMinor: cents.optional(),
  })
  .strict();

export const sendReviewSchema = z
  .object({
    recipientId: identifier,
    amountMinor: positiveCents,
    note: z
      .string()
      .trim()
      .max(100)
      .transform((value) => value || 'Just because.'),
  })
  .strict();
export const authorizeSchema = z
  .object({ reviewDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const issueSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const personaSchema = z.object({ personId: identifier }).strict();
export const emptySchema = z.object({}).strict();
