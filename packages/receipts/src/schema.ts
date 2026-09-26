import { z } from 'zod';
import { RECEIPT_MAX_LINES, type ReceiptProposal } from './contracts';
import { ReceiptError } from './errors';

const cents = z
  .string()
  .regex(/^(0|[1-9]\d{0,7})$/)
  .refine((v) => BigInt(v) <= 10_000_000n)
  .nullable();
export const extractionSchema = z
  .object({
    title: z.string().min(1).max(100),
    currency: z.enum(['USD', 'unknown', 'unsupported']),
    items: z
      .array(
        z
          .object({
            description: z.string().min(1).max(100),
            quantity: z
              .string()
              .regex(/^\d{1,4}(\.\d{1,3})?$/)
              .nullable(),
            amountMinor: cents,
          })
          .strict(),
      )
      .max(RECEIPT_MAX_LINES),
    subtotalMinor: cents,
    totalMinor: cents,
    taxMinor: cents,
    tipMinor: cents,
    discountMinor: cents,
    serviceChargeMinor: cents,
    confidence: z.enum(['high', 'medium', 'low']),
    concerns: z
      .array(
        z.enum([
          'unreadable',
          'cropped',
          'handwritten',
          'not_receipt',
          'ambiguous_total',
          'included_tax',
          'included_service_charge',
          'sensitive_text',
        ]),
      )
      .max(8),
  })
  .strict();

const nullableString = { type: ['string', 'null'] };
/** Keep provider JSON Schema simple; stronger bounded validation always runs locally. */
export const extractionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    currency: { type: 'string', enum: ['USD', 'unknown', 'unsupported'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          quantity: nullableString,
          amountMinor: nullableString,
        },
        required: ['description', 'quantity', 'amountMinor'],
      },
    },
    subtotalMinor: nullableString,
    totalMinor: nullableString,
    taxMinor: nullableString,
    tipMinor: nullableString,
    discountMinor: nullableString,
    serviceChargeMinor: nullableString,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    concerns: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'unreadable',
          'cropped',
          'handwritten',
          'not_receipt',
          'ambiguous_total',
          'included_tax',
          'included_service_charge',
          'sensitive_text',
        ],
      },
    },
  },
  required: [
    'title',
    'currency',
    'items',
    'subtotalMinor',
    'totalMinor',
    'taxMinor',
    'tipMinor',
    'discountMinor',
    'serviceChargeMinor',
    'confidence',
    'concerns',
  ],
};

const concernCopy = {
  unreadable: 'Some receipt text was difficult to read.',
  cropped: 'The photo may be missing part of the receipt.',
  handwritten: 'Check the handwritten amounts.',
  not_receipt: 'This photo may not be a receipt.',
  ambiguous_total: 'Confirm which amount is the final total.',
  included_tax: 'Check whether tax is already included in item prices.',
  included_service_charge: 'Check whether the service charge is already included.',
  sensitive_text: 'Check the descriptions for private information before sharing.',
} as const;

/** Conservative leakage guard, not full PII redaction. Never claim a safe image derivative. */
export function containsSensitiveText(value: string): boolean {
  return (
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value) ||
    /(?:\d[\s().+-]*){7,}/.test(value) ||
    /(?:card|account|acct|loyalty|member|customer|authorization|auth\s*code)\s*(?:no\.?|number|#|:|ending|[*x•-])*\s*\d{3,}/i.test(
      value,
    ) ||
    /[*x•]{3,}[\s-]*\d{3,}/i.test(value) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  );
}

export function validateProposal(input: unknown): ReceiptProposal {
  const parsed = extractionSchema.safeParse(input);
  if (!parsed.success)
    throw new ReceiptError(
      'EXTRACTION_INVALID',
      'The receipt could not be read reliably. Try a clearer photo or enter it manually.',
    );
  const value = parsed.data;
  if (value.concerns.includes('not_receipt'))
    throw new ReceiptError(
      'NOT_A_RECEIPT',
      'Choose a receipt photo, or enter the expense manually.',
    );
  const warnings = value.concerns.map((concern) => concernCopy[concern] as string);
  let removedText = false;
  const clean = (text: string, fallback: string): string => {
    if (containsSensitiveText(text)) {
      removedText = true;
      return fallback;
    }
    return text.trim() || fallback;
  };
  const title = clean(value.title, 'Your receipt');
  const items = value.items.map((item, index) => ({
    ...item,
    id: `receipt-line-${index + 1}`,
    description: clean(item.description, `Item ${index + 1}`),
  }));
  if (removedText)
    warnings.push(
      'Some descriptions were hidden because they may contain private information. Rename them before sharing.',
    );
  const components = [
    value.taxMinor,
    value.tipMinor,
    value.discountMinor,
    value.serviceChargeMinor,
  ];
  const complete =
    items.length > 0 &&
    items.every((item) => item.amountMinor !== null) &&
    value.totalMinor !== null &&
    value.subtotalMinor !== null &&
    components.every((v) => v !== null);
  let reconciled = false;
  if (complete) {
    const subtotal = items.reduce((total, item) => total + BigInt(item.amountMinor!), 0n);
    const calculated =
      subtotal +
      BigInt(value.taxMinor!) +
      BigInt(value.tipMinor!) +
      BigInt(value.serviceChargeMinor!) -
      BigInt(value.discountMinor!);
    reconciled =
      subtotal === BigInt(value.subtotalMinor!) &&
      calculated === BigInt(value.totalMinor!) &&
      calculated > 0n &&
      value.currency === 'USD';
    if (!reconciled)
      warnings.push(
        'The item and adjustment totals do not match the stated total. Check the amounts before continuing.',
      );
  } else
    warnings.push(
      'Some amounts are missing or unclear. Confirm them before continuing; a blank amount is not zero.',
    );
  if (value.currency !== 'USD')
    warnings.push('Tallie currently supports USD. Confirm the currency before continuing.');
  if (value.confidence !== 'high') warnings.push('Please check each line against your photo.');
  const { concerns: _concerns, ...rest } = value;
  return { ...rest, schemaVersion: 1, title, items, warnings: [...new Set(warnings)], reconciled };
}
