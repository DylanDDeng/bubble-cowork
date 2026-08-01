import { useState } from 'react';
import type { BubblePermissionMode } from '../types';
import { FullAccessPermissionIcon } from './FullAccessPermissionIcon';

// Mirrors the Bubble SDK `PermissionMode` union minus 'plan': like the Claude
// picker, plan mode is entered via /plan and shown as a separate pill, so it
// is deliberately not a menu option here.
const BUBBLE_PERMISSION_MODES: BubblePermissionMode[] = [
  'default',
  'bypassPermissions',
];

export function BubblePermissionModePicker({
  value,
  onChange,
  disabled,
  menuSide = 'top',
}: {
  value: BubblePermissionMode;
  onChange: (mode: BubblePermissionMode) => void;
  disabled?: boolean;
  /** Which side the menu opens toward. Bottom-anchored composers open 'top'
   * (default); the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const current = MODE_META[value];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'bypassPermissions'
            ? 'text-[#E97E4F] hover:text-[#D96E42]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
        {value === 'bypassPermissions' ? (
          <FullAccessPermissionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{current.label}</span>
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`popover-surface absolute left-0 z-20 flex min-w-[176px] flex-col p-1 ${
              menuSide === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
            }`}
          >
            {BUBBLE_PERMISSION_MODES.map((mode) => (
              <BubblePermissionModeOption
                key={mode}
                mode={mode}
                current={value}
                onSelect={(nextMode) => {
                  onChange(nextMode);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const MODE_META: Record<
  BubblePermissionMode,
  {
    label: string;
  }
> = {
  default: {
    label: 'Default',
  },
  plan: {
    label: 'Plan',
  },
  bypassPermissions: {
    label: 'Full Access',
  },
};

function BubblePermissionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: BubblePermissionMode;
  current: BubblePermissionMode;
  onSelect: (mode: BubblePermissionMode) => void;
}) {
  const active = current === mode;
  const meta = MODE_META[mode];

  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span className="truncate">{meta.label}</span>
    </button>
  );
}
