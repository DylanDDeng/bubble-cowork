import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ClaudeModelConfig } from '../types';
import { buildClaudeModelOptions, formatClaudeModelLabel } from '../utils/claude-model';

interface ClaudeModelPickerProps {
  value: string | null;
  config: ClaudeModelConfig;
  runtimeModel?: string | null;
  onChange: (model: string) => void;
  disabled?: boolean;
}

export function ClaudeModelPicker({
  value,
  config,
  runtimeModel,
  onChange,
  disabled,
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
        className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-transparent bg-[var(--bg-tertiary)] px-3 py-2 text-sm transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-50"
        title={currentLabel}
      >
        <span className="truncate text-[var(--text-secondary)]">{currentLabel}</span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] py-1 shadow-lg">
            {options.map((model) => (
              <button
                key={model}
                onClick={() => {
                  onChange(model);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                  resolvedValue === model
                    ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                }`}
                title={model}
              >
                <div className="truncate">{formatClaudeModelLabel(model)}</div>
                {runtimeModel === model && (
                  <div className="text-xs text-[var(--text-muted)]">Current runtime model</div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
