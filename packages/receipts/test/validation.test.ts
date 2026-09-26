import { describe, expect, it } from 'vitest';
import { containsSensitiveText, validateProposal } from '../src/schema';
import { decodeReceiptUpload, sniffReceiptType } from '../src/upload';
import { receiptPath } from '../src/storage';

export const validExtraction = {
  title: 'Little Lantern',
  currency: 'USD',
  items: [
    { description: 'Food', quantity: '1', amountMinor: '6000' },
    { description: 'Wine', quantity: '1', amountMinor: '3000' },
  ],
  subtotalMinor: '9000',
  totalMinor: '11700',
  taxMinor: '900',
  tipMinor: '1800',
  discountMinor: '0',
  serviceChargeMinor: '0',
  confidence: 'high',
  concerns: [],
};

describe('receipt proposal boundary', () => {
  it('reconciles exact cents and preserves extended line totals separately from quantity', () => {
    const proposal = validateProposal({
      ...validExtraction,
      items: [{ description: 'Dinner for two', quantity: '2', amountMinor: '9000' }],
    });
    expect(proposal.reconciled).toBe(true);
    expect(proposal.items[0]?.amountMinor).toBe('9000');
    expect(proposal.items[0]?.quantity).toBe('2');
  });
  it('never fills an unreadable tip using a residual', () => {
    const proposal = validateProposal({ ...validExtraction, tipMinor: null });
    expect(proposal.tipMinor).toBeNull();
    expect(proposal.reconciled).toBe(false);
    expect(proposal.warnings.join(' ')).toContain('blank amount is not zero');
  });
  it.each(['-1', '1.00', '1e3', '01', '10000001', '9007199254740992'])(
    'rejects invalid money %s',
    (amountMinor) => {
      expect(() => validateProposal({ ...validExtraction, totalMinor: amountMinor })).toThrow();
    },
  );
  it('flags mismatch without creating a balancing item', () => {
    const proposal = validateProposal({ ...validExtraction, totalMinor: '9999' });
    expect(proposal.reconciled).toBe(false);
    expect(proposal.items).toHaveLength(2);
    expect(proposal.totalMinor).toBe('9999');
  });
  it('treats unsupported currency as unresolved', () => {
    const proposal = validateProposal({ ...validExtraction, currency: 'unsupported' });
    expect(proposal.reconciled).toBe(false);
    expect(proposal.warnings.join(' ')).toContain('supports USD');
  });
  it('rejects commands, arbitrary model properties, excessive lines and nonreceipts', () => {
    expect(() => validateProposal({ ...validExtraction, sendMoney: true })).toThrow();
    expect(() =>
      validateProposal({ ...validExtraction, items: Array(101).fill(validExtraction.items[0]) }),
    ).toThrow();
    expect(() => validateProposal({ ...validExtraction, concerns: ['not_receipt'] })).toThrow();
  });
  it('substitutes neutral labels for obvious personal identifiers and bidi controls', () => {
    const result = validateProposal({
      ...validExtraction,
      title: 'Customer joe@example.com',
      items: [
        { description: 'Card ending 4242', quantity: null, amountMinor: '6000' },
        { description: 'Call +1 (212) 555-0100', quantity: null, amountMinor: '3000' },
      ],
    });
    expect(result.title).toBe('Your receipt');
    expect(result.items.map((v) => v.description)).toEqual(['Item 1', 'Item 2']);
    expect(containsSensitiveText('total\u202e0')).toBe(true);
    expect(containsSensitiveText('Table 12 burger')).toBe(false);
    expect(result.warnings.join(' ')).toContain('private information');
  });
});

describe('upload byte boundary', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  it('requires canonical base64 and matching byte type, not a supplied MIME alone', () => {
    expect(decodeReceiptUpload(jpeg.toString('base64'), 'image/jpeg')).toEqual(jpeg);
    expect(() => decodeReceiptUpload(jpeg.toString('base64'), 'image/png')).toThrow();
    expect(() => decodeReceiptUpload('<svg onload="alert(1)">', 'image/png')).toThrow();
    expect(() =>
      decodeReceiptUpload('data:image/jpeg;base64,' + jpeg.toString('base64'), 'image/jpeg'),
    ).toThrow();
    expect(() => decodeReceiptUpload('Zg==\n', 'image/jpeg')).toThrow();
    expect(sniffReceiptType(Buffer.from('<html>'))).toBeNull();
  });
  it('bounds decoded upload bytes before processing', () => {
    expect(() => decodeReceiptUpload('A'.repeat(11_184_816), 'image/jpeg')).toThrow();
  });
  it('never accepts caller-controlled file paths', () => {
    expect(() => receiptPath('../../.env', 'original', '/tmp/receipts')).toThrow();
    expect(() => receiptPath('/etc/passwd', 'normalized', '/tmp/receipts')).toThrow();
  });
});
