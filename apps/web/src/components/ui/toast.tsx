'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: 'success' | 'info' | 'error';
}

interface Toast extends ToastInput {
  id: number;
}
interface ToastContextValue {
  toast: (input: ToastInput | string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id: number) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), 6500),
      );
    },
    [dismiss],
  );

  const pauseDismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const toast = useCallback(
    (input: ToastInput | string) => {
      const entry: Toast = {
        ...(typeof input === 'string' ? { title: input } : input),
        id: ++nextId.current,
      };
      setToasts((current) => [...current.slice(-2), entry]);
      scheduleDismiss(entry.id);
    },
    [scheduleDismiss],
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers.values()) clearTimeout(timer);
      activeTimers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="ui-toast-region" aria-label="Notifications" role="region">
        <div className="ui-toast-announcements" role="status" aria-live="polite" aria-atomic="true">
          {toasts.at(-1)?.title}
          {toasts.at(-1)?.description ? `. ${toasts.at(-1)?.description}` : ''}
        </div>
        {toasts.map((entry) => (
          <div
            key={entry.id}
            className={`ui-toast ui-toast--${entry.tone ?? 'success'}`}
            onMouseEnter={() => pauseDismiss(entry.id)}
            onMouseLeave={() => scheduleDismiss(entry.id)}
            onFocus={() => pauseDismiss(entry.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) scheduleDismiss(entry.id);
            }}
          >
            <span className="ui-toast-icon">
              <Icon
                name={
                  entry.tone === 'error' ? 'info' : entry.tone === 'info' ? 'sparkles' : 'check'
                }
                size={18}
              />
            </span>
            <div className="ui-toast-copy">
              <strong>{entry.title}</strong>
              {entry.description && <p>{entry.description}</p>}
            </div>
            <button
              type="button"
              className="ui-toast-dismiss"
              aria-label={`Dismiss: ${entry.title}`}
              onClick={() => dismiss(entry.id)}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}
