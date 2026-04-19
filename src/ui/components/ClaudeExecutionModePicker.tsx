import { useState } from 'react';
import { ChevronUp } from 'lucide-react';
import type { ClaudeExecutionMode } from '../types';

export function ClaudeExecutionModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ClaudeExecutionMode;
  onChange: (mode: ClaudeExecutionMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const normalizedValue = value === 'plan' ? 'plan' : 'execute';
  const current = EXECUTION_MODE_META[normalizedValue];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          normalizedValue === 'plan'
            ? 'text-[var(--accent)] hover:text-[var(--accent-hover)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span>{current.label}</span>
        <ChevronUp className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="popover-surface absolute bottom-full left-0 z-20 mb-2 flex min-w-[148px] flex-col gap-0.5 p-1.5">
            <ExecutionModeOption
              mode="execute"
              current={normalizedValue}
              onSelect={(mode) => {
                onChange(mode);
                setOpen(false);
              }}
            />
            <ExecutionModeOption
              mode="plan"
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

const EXECUTION_MODE_META: Record<ClaudeExecutionMode, { label: string }> = {
  execute: {
    label: 'Execute',
  },
  plan: {
    label: 'Plan',
  },
};

function ExecutionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: ClaudeExecutionMode;
  current: ClaudeExecutionMode;
  onSelect: (mode: ClaudeExecutionMode) => void;
}) {
  const active = current === mode;
  const meta = EXECUTION_MODE_META[mode];

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
