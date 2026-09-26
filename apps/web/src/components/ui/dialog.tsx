'use client';

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

let scrollLockCount = 0;
let originalOverflow = '';

function lockPageScroll(): () => void {
  if (scrollLockCount === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;

  return () => {
    scrollLockCount -= 1;
    if (scrollLockCount === 0) document.body.style.overflow = originalOverflow;
  };
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className = '',
  initialFocusRef,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOutside = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const releaseScroll = lockPageScroll();
    initialFocusRef?.current?.focus({ preventScroll: true });

    return () => {
      dialog.close();
      releaseScroll();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open, initialFocusRef]);

  function isOutside(clientX: number, clientY: number): boolean {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return Boolean(
      bounds &&
      (clientX < bounds.left ||
        clientX > bounds.right ||
        clientY < bounds.top ||
        clientY > bounds.bottom),
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className={`ui-dialog ui-dialog--${size} ${className}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        // Keep controlled state in sync with a child form using method="dialog".
        if (open && !event.currentTarget.open) onClose();
      }}
      onPointerDown={(event) => {
        pointerStartedOutside.current =
          event.target === event.currentTarget && isOutside(event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (
          pointerStartedOutside.current &&
          event.target === event.currentTarget &&
          isOutside(event.clientX, event.clientY)
        )
          onClose();
        pointerStartedOutside.current = false;
      }}
    >
      <div className="ui-dialog-shell">
        <header className="ui-dialog-header">
          <div className="ui-dialog-heading">
            <h2 id={titleId} className="ui-dialog-title">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="ui-dialog-description">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-dialog-close"
            aria-label="Close dialog"
          >
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="ui-dialog-content">{children}</div>
        {footer && <footer className="ui-dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
