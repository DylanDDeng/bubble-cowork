import { useState } from 'react';
import { ChevronUp } from 'lucide-react';
import type { ClaudeAccessMode } from '../types';

export function ClaudeAccessModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ClaudeAccessMode;
  onChange: (mode: ClaudeAccessMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const normalizedValue = value === 'fullAccess' ? 'fullAccess' : 'default';
  const current = ACCESS_MODE_META[normalizedValue];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          normalizedValue === 'fullAccess'
            ? 'text-[#b42318] hover:text-[#991b1b]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span>{current.label}</span>
        <ChevronUp className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 flex min-w-[152px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg">
            <AccessModeOption
              mode="default"
              current={normalizedValue}
              onSelect={(mode) => {
                onChange(mode);
                setOpen(false);
              }}
            />
            <AccessModeOption
              mode="fullAccess"
              current={normalizedValue}
              onSelect={(mode) => {
                onChange(mode);
                setOpen(false);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

const ACCESS_MODE_META: Record<
  ClaudeAccessMode,
  { label: string }
> = {
  default: {
    label: 'Default',
  },
  fullAccess: {
    label: 'Full Access',
  },
};

function AccessModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: ClaudeAccessMode;
  current: ClaudeAccessMode;
  onSelect: (mode: ClaudeAccessMode) => void;
}) {
  const active = current === mode;
  const meta = ACCESS_MODE_META[mode];

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
