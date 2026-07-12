import { useState } from 'react';
import type { OpenCodePermissionMode } from '../types';
import { FullAccessPermissionIcon } from './FullAccessPermissionIcon';

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

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'fullAccess'
            ? 'text-[#E97E4F] hover:text-[#D96E42]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
        {value === 'fullAccess' ? (
          <FullAccessPermissionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{current.label}</span>
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
