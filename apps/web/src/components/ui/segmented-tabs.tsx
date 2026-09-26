'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedTabsProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly SegmentedOption<Value>[];
  onChange: (value: Value) => void;
  className?: string;
}

/** A single-choice control. Radio semantics avoid implying tab panels that do not exist. */
export function SegmentedTabs<Value extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: SegmentedTabsProps<Value>) {
  const groupId = useId();
  const refs = useRef(new Map<Value, HTMLButtonElement>());

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, current: Value) {
    const enabledOptions = options.filter((option) => !option.disabled);
    if (enabledOptions.length === 0) return;

    const index = enabledOptions.findIndex((option) => option.value === current);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % enabledOptions.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + enabledOptions.length) % enabledOptions.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = enabledOptions.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const option = enabledOptions[nextIndex];
    if (!option) return;
    onChange(option.value);
    refs.current.get(option.value)?.focus();
  }

  const hasEnabledSelection = options.some((option) => option.value === value && !option.disabled);
  const firstEnabled = options.find((option) => !option.disabled)?.value;

  return (
    <div className={`ui-segmented ${className}`} role="radiogroup" aria-label={label} id={groupId}>
      {options.map((option) => (
        <button
          key={option.value}
          ref={(element) => {
            if (element) refs.current.set(option.value, element);
            else refs.current.delete(option.value);
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          tabIndex={
            hasEnabledSelection
              ? option.value === value
                ? 0
                : -1
              : option.value === firstEnabled
                ? 0
                : -1
          }
          className={`ui-segmented-option${option.value === value ? ' ui-segmented-option--selected' : ''}`}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => moveSelection(event, option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
