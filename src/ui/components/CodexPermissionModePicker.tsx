import { useState } from 'react';
import { ChevronUp } from 'lucide-react';
import type { CodexPermissionMode } from '../types';

export function CodexPermissionModePicker({
  value,
  onChange,
  disabled,
}: {
  value: CodexPermissionMode;
  onChange: (mode: CodexPermissionMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = MODE_META[value];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'fullAccess'
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
            {(['defaultPermissions', 'fullAccess'] as const).map((mode) => (
              <CodexPermissionModeOption
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
  CodexPermissionMode,
  {
    label: string;
  }
> = {
  defaultPermissions: {
    label: 'Default',
  },
  fullAccess: {
    label: 'Full Access',
  },
};

function CodexPermissionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: CodexPermissionMode;
  current: CodexPermissionMode;
  onSelect: (mode: CodexPermissionMode) => void;
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
