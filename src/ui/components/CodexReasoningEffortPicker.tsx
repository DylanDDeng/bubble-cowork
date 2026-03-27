import { useState } from 'react';
import { ChevronUp } from 'lucide-react';
import type { CodexReasoningEffort, CodexReasoningLevelOption } from '../types';

export function CodexReasoningEffortPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: CodexReasoningEffort;
  options: CodexReasoningLevelOption[];
  onChange: (effort: CodexReasoningEffort) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.effort === value) || options[0];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        title={current?.description}
      >
        <span>{current?.effort || value}</span>
        <ChevronUp className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 flex min-w-[220px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg">
            {options.map((option) => {
              const active = option.effort === value;
              return (
                <button
                  key={option.effort}
                  type="button"
                  onClick={() => {
                    onChange(option.effort);
                    setOpen(false);
                  }}
                  className={`rounded-lg px-3 py-2 text-left transition-colors ${
                    active
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <div className="text-[13px] font-semibold">{option.effort}</div>
                  <div className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
