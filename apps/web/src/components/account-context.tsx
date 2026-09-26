'use client';
import { createContext, useCallback, useContext } from 'react';
import { api } from '@/lib/client';

export const AccountContext = createContext<string | null>(null);
/** Bind actions to the account currently on screen, including after another tab signs in. */
export function useAccountApi() {
  const accountId = useContext(AccountContext);
  if (!accountId) throw new Error('Account context is required.');
  return useCallback(
    <T,>(path: string, body?: unknown, key?: string, signal?: AbortSignal) =>
      api<T>(path, body, key, signal, accountId),
    [accountId],
  );
}
