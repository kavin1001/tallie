import type { ApiResponse } from '@tallie/db/contracts';
import { formatUsd, parseUsd } from '@tallie/domain';

export class RequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  signal?: AbortSignal,
  expectedAccountId?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(expectedAccountId ? { 'X-Tallie-Account': expectedAccountId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result: ApiResponse<T>;
    try {
      result = (await response.json()) as ApiResponse<T>;
    } catch {
      throw new RequestError(
        'UNAVAILABLE',
        'Tallie couldn’t connect. Please try again.',
        response.status,
      );
    }
    if ('error' in result)
      throw new RequestError(result.error.code, result.error.message, response.status);
    if (!response.ok)
      throw new RequestError(
        'UNAVAILABLE',
        'Something went wrong. Please try again.',
        response.status,
      );
    return result.data;
  } finally {
    clearTimeout(timeout);
  }
}

export function money(amount: string | bigint): string {
  return formatUsd(BigInt(amount));
}
export function cents(input: string): string {
  return parseUsd(input).toString();
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
export function shortDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(date),
  );
}
