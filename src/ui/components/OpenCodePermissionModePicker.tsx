import { useState } from 'react';
import { ChevronUp, ChevronDown } from './icons';
import type { OpenCodePermissionMode } from '../types';

export function OpenCodePermissionModePicker({
  value,
  onChange,
  disabled,
  menuSide = 'top',
}: {
  value: OpenCodePermissionMode;
  onChange: (mode: OpenCodePermissionMode) => void;
  disabled?: boolean;
  /** Which side the menu opens toward. Bottom-anchored composers open 'top'
   * (default); the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const current = MODE_META[value];
  const Chevron = menuSide === 'bottom' ? ChevronDown : ChevronUp;

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'fullAccess'
            ? 'text-[#b42318] hover:text-[#991b1b]'
            : value === 'plan'
              ? 'text-[#7c3aed] hover:text-[#6d28d9]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span>{current.label}</span>
        <Chevron className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`popover-surface absolute left-0 z-20 flex min-w-[152px] flex-col gap-0.5 p-1.5 ${
              menuSide === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
            }`}
          >
            {(['defaultPermissions', 'plan', 'fullAccess'] as const).map((mode) => (
              <OpenCodePermissionModeOption
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
  OpenCodePermissionMode,
  {
    label: string;
  }
> = {
  defaultPermissions: {
    label: 'Default',
  },
  plan: {
    label: 'Plan',
  },
  fullAccess: {
    label: 'Full Access',
  },
};

function OpenCodePermissionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: OpenCodePermissionMode;
  current: OpenCodePermissionMode;
  onSelect: (mode: OpenCodePermissionMode) => void;
}) {
  const active = current === mode;
  const meta = MODE_META[mode];

  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span className="truncate">{meta.label}</span>
    </button>
  );
}
