import { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ClaudeModelConfig } from '../types';
import { buildClaudeModelOptions, formatClaudeModelLabel } from '../utils/claude-model';

interface ClaudeModelPickerProps {
  value: string | null;
  config: ClaudeModelConfig;
  runtimeModel?: string | null;
  onChange: (model: string) => void;
  disabled?: boolean;
  embedded?: boolean;
}

export function ClaudeModelPicker({
  value,
  config,
  runtimeModel,
  onChange,
  disabled,
  embedded = false,
}: ClaudeModelPickerProps) {
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => buildClaudeModelOptions(config, [value]),
    [config, value]
  );

  const resolvedValue = value || config.defaultModel || options[0] || '';
  const currentLabel = resolvedValue ? formatClaudeModelLabel(resolvedValue) : 'Claude model';

  return (
    <div className="relative no-drag">
      <button
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={`flex items-center justify-between gap-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          embedded
            ? `min-w-[150px] max-w-[190px] rounded-lg px-3 py-2 ${
                open
                  ? 'bg-[var(--bg-tertiary)]'
                  : 'bg-transparent hover:bg-[var(--bg-tertiary)]'
              }`
            : 'min-w-[156px] max-w-[196px] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 shadow-sm hover:bg-[var(--bg-tertiary)]'
        }`}
        title={currentLabel}
      >
        <span className="truncate text-[var(--text-secondary)]">{currentLabel}</span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 min-w-[208px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-[0_14px_32px_rgba(15,23,42,0.10)]">
            <div className="px-2 py-1 text-[10px] font-medium text-[var(--text-muted)]">
              Claude Code
            </div>
            {options.map((model) => (
              <button
                key={model}
                onClick={() => {
                  onChange(model);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                title={model}
              >
                <div className="min-w-0 truncate">{formatClaudeModelLabel(model)}</div>
                {resolvedValue === model && (
                  <Check className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
