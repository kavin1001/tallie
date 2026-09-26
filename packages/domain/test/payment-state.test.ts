import { describe, expect, it } from 'vitest';
import { applyOperationEvent, getPaymentActions, type PaymentActionContext } from '../src';

const payable: PaymentActionContext = {
  requestStatus: 'OPEN',
  operationState: null,
  lane: 'natural_request',
  hasIssue: false,
  payerConnected: true,
  isPayer: true,
  isRequester: false,
};

describe('operation state', () => {
  it('accepts duplicate observations without creating another operation', () => {
    expect(applyOperationEvent('prepared', 'dispatch')).toBe('dispatching');
    expect(applyOperationEvent('dispatching', 'dispatch')).toBe('dispatching');
    expect(applyOperationEvent('dispatching', 'accept')).toBe('accepted');
    expect(applyOperationEvent('accepted', 'accept')).toBe('accepted');
  });

  it('requires reconciliation after an unknown network outcome', () => {
    expect(applyOperationEvent('dispatching', 'outcome_unknown')).toBe('unknown');
    expect(() => applyOperationEvent('unknown', 'dispatch')).toThrow();
    expect(() => applyOperationEvent('unknown', 'reject_before_acceptance')).toThrow();
    expect(applyOperationEvent('unknown', 'reconcile_accepted')).toBe('accepted');
    expect(applyOperationEvent('unknown', 'reconcile_rejected')).toBe('rejected');
  });

  it('does not regress an accepted operation after a late error', () => {
    expect(() => applyOperationEvent('accepted', 'reject_before_acceptance')).toThrow();
    expect(() => applyOperationEvent('accepted', 'dispatch')).toThrow();
  });
});

describe('server-derived display actions', () => {
  it('offers review only to an eligible payer with an open request and a free payment lane', () => {
    expect(getPaymentActions(payable)).toEqual(['review_payment']);
    expect(getPaymentActions({ ...payable, payerConnected: false })).toEqual(['finish_setup']);
    expect(getPaymentActions({ ...payable, isPayer: false, isRequester: true })).toEqual([]);
    expect(getPaymentActions({ ...payable, isPayer: false })).toEqual([]);
  });

  it.each(['prepared', 'dispatching', 'unknown', 'accepted'] as const)(
    'blocks another debit while the operation is %s',
    (operationState) => {
      expect(getPaymentActions({ ...payable, operationState })).toEqual(['wait_for_provider']);
    },
  );

  it.each(['natural_payment', 'switching_external', 'reconciliation_required'] as const)(
    'does not release a %s lane',
    (lane) => {
      expect(getPaymentActions({ ...payable, lane })).toEqual(['wait_for_provider']);
    },
  );

  it('fails closed on an unknown future provider status', () => {
    expect(getPaymentActions({ ...payable, requestStatus: 'SOME_NEW_HOLD' })).toEqual([
      'wait_for_provider',
    ]);
  });

  it('keeps external reporting and requester confirmation distinct from payment', () => {
    expect(
      getPaymentActions({ ...payable, requestStatus: 'CANCELED', lane: 'external_open' }),
    ).toEqual(['report_external']);
    expect(
      getPaymentActions({ ...payable, requestStatus: 'CANCELED', lane: 'external_reported' }),
    ).toEqual([]);
    expect(
      getPaymentActions({
        ...payable,
        requestStatus: 'CANCELED',
        lane: 'external_reported',
        isPayer: false,
        isRequester: true,
      }),
    ).toEqual(['confirm_received']);
  });

  it('requires cancellation evidence before enabling an external collection lane', () => {
    expect(getPaymentActions({ ...payable, lane: 'external_open' })).toEqual(['wait_for_provider']);
    expect(
      getPaymentActions({
        ...payable,
        lane: 'external_reported',
        isPayer: false,
        isRequester: true,
      }),
    ).toEqual(['wait_for_provider']);
    expect(getPaymentActions({ ...payable, requestStatus: null, lane: 'external_open' })).toEqual([
      'report_external',
    ]);
  });

  it('blocks collection when a share is disputed, completed, failed, or returned', () => {
    expect(getPaymentActions({ ...payable, hasIssue: true })).toEqual(['review_issue']);
    for (const requestStatus of [
      'COMPLETED',
      'FAILED',
      'RETURNED',
      'CANCELED',
      'DECLINED',
      'EXPIRED',
    ]) {
      expect(getPaymentActions({ ...payable, requestStatus })).toEqual([]);
    }
  });
});
