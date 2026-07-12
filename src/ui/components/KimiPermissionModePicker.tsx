import { useState } from 'react';
import type { KimiPermissionMode } from '../types';

export function KimiPermissionModePicker({
  value,
  onChange,
  disabled,
  menuSide = 'top',
}: {
  value: KimiPermissionMode;
  onChange: (mode: KimiPermissionMode) => void;
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
        className={`inline-flex items-center rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'yolo'
            ? 'text-[#b42318] hover:text-[#991b1b]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
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
            {(['default', 'plan', 'auto', 'yolo'] as const).map((mode) => (
              <KimiPermissionModeOption
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
  KimiPermissionMode,
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
  auto: {
    label: 'Auto',
  },
  yolo: {
    label: 'YOLO',
  },
};

function KimiPermissionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: KimiPermissionMode;
  current: KimiPermissionMode;
  onSelect: (mode: KimiPermissionMode) => void;
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
