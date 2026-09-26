import { DomainError } from './errors';

/** Transport outcome is separate from provider payment status. Accepted never means paid. */
export type OperationState = 'prepared' | 'dispatching' | 'accepted' | 'unknown' | 'rejected';
export type OperationEvent =
  | 'dispatch'
  | 'accept'
  | 'outcome_unknown'
  | 'reject_before_acceptance'
  | 'reconcile_accepted'
  | 'reconcile_rejected';

const OPERATION_TRANSITIONS: Readonly<
  Record<OperationState, Partial<Record<OperationEvent, OperationState>>>
> = {
  prepared: { dispatch: 'dispatching', reject_before_acceptance: 'rejected' },
  dispatching: {
    dispatch: 'dispatching',
    accept: 'accepted',
    outcome_unknown: 'unknown',
    reject_before_acceptance: 'rejected',
  },
  unknown: {
    outcome_unknown: 'unknown',
    reconcile_accepted: 'accepted',
    reconcile_rejected: 'rejected',
  },
  accepted: { accept: 'accepted', reconcile_accepted: 'accepted' },
  rejected: { reject_before_acceptance: 'rejected', reconcile_rejected: 'rejected' },
};

/** Caller must persist under a lock and bind the event to the same durable operation. */
export function applyOperationEvent(state: OperationState, event: OperationEvent): OperationState {
  const next = OPERATION_TRANSITIONS[state]?.[event];
  if (!next) {
    throw new DomainError(
      'INVALID_TRANSITION',
      'This operation needs reconciliation before its state can change.',
    );
  }
  return next;
}

export type CollectionLane =
  | 'natural_request'
  | 'natural_payment'
  | 'switching_external'
  | 'external_open'
  | 'external_reported'
  | 'reconciliation_required';

export type RequestStatus =
  'OPEN' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETURNED' | 'CANCELED' | 'DECLINED' | 'EXPIRED';

export type PaymentAction =
  | 'review_payment'
  | 'finish_setup'
  | 'wait_for_provider'
  | 'report_external'
  | 'confirm_received'
  | 'review_issue';

export interface PaymentActionContext {
  /** Provider values remain strings so an unknown future status fails closed. */
  readonly requestStatus: string | null;
  readonly operationState: OperationState | null;
  readonly lane: CollectionLane | null;
  readonly hasIssue: boolean;
  readonly payerConnected: boolean;
  readonly isPayer: boolean;
  readonly isRequester: boolean;
}

const KNOWN_REQUEST_STATUSES = new Set<RequestStatus>([
  'OPEN',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETURNED',
  'CANCELED',
  'DECLINED',
  'EXPIRED',
]);

/** Display guidance only. Every command must recheck identity, assurance, consent, and lane atomically. */
export function getPaymentActions(context: PaymentActionContext): readonly PaymentAction[] {
  if (!context.isPayer && !context.isRequester) return Object.freeze([]);
  if (context.hasIssue) return Object.freeze(['review_issue']);
  if (
    context.requestStatus !== null &&
    !KNOWN_REQUEST_STATUSES.has(context.requestStatus as RequestStatus)
  ) {
    return Object.freeze(['wait_for_provider']);
  }
  if (
    context.lane === 'reconciliation_required' ||
    context.lane === 'switching_external' ||
    context.lane === 'natural_payment' ||
    context.operationState === 'prepared' ||
    context.operationState === 'dispatching' ||
    context.operationState === 'unknown' ||
    context.requestStatus === 'PROCESSING'
  ) {
    return Object.freeze(['wait_for_provider']);
  }
  if (context.lane === 'external_reported') {
    if (context.requestStatus !== null && context.requestStatus !== 'CANCELED') {
      return Object.freeze(['wait_for_provider']);
    }
    return Object.freeze(context.isRequester ? ['confirm_received'] : []);
  }
  if (context.lane === 'external_open') {
    if (context.requestStatus !== null && context.requestStatus !== 'CANCELED') {
      return Object.freeze(['wait_for_provider']);
    }
    return Object.freeze(context.isPayer ? ['report_external'] : []);
  }
  if (context.requestStatus === 'OPEN' && context.lane === 'natural_request' && context.isPayer) {
    // An accepted fulfillment with an outdated OPEN request must not expose another payment.
    if (context.operationState === 'accepted') return Object.freeze(['wait_for_provider']);
    return Object.freeze([context.payerConnected ? 'review_payment' : 'finish_setup']);
  }
  return Object.freeze([]);
}
