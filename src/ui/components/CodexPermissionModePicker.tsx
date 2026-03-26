import { useState } from 'react';
import { ChevronUp, Shield, TriangleAlert } from 'lucide-react';
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
        className={`inline-flex items-center gap-2 rounded-[14px] border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          value === 'fullAccess'
            ? 'border-[rgba(239,68,68,0.24)] bg-[rgba(239,68,68,0.08)] text-[#b42318] hover:bg-[rgba(239,68,68,0.12)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <current.icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span>{current.label}</span>
        <ChevronUp className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 flex min-w-[168px] flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg">
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
    icon: typeof Shield | typeof TriangleAlert;
  }
> = {
  defaultPermissions: {
    label: 'Default',
    icon: Shield,
  },
  fullAccess: {
    label: 'Full Access',
    icon: TriangleAlert,
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
  const Icon = meta.icon;

  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
        mode === 'fullAccess'
          ? active
            ? 'border-[rgba(239,68,68,0.32)] bg-[rgba(239,68,68,0.10)] text-[#b42318]'
            : 'border-[rgba(239,68,68,0.16)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[rgba(239,68,68,0.06)]'
          : active
            ? 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="truncate text-[13px] font-semibold">{meta.label}</span>
      </div>
    </button>
  );
}
