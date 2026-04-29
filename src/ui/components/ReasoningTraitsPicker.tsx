import { Check, ChevronDown, Zap } from 'lucide-react';
import { useState } from 'react';
import type {
  ClaudeReasoningEffort,
  ClaudeReasoningLevelOption,
  CodexReasoningEffort,
  CodexReasoningLevelOption,
} from '../types';

type ReasoningEffort = ClaudeReasoningEffort | CodexReasoningEffort;
type ReasoningOption<T extends ReasoningEffort> =
  T extends ClaudeReasoningEffort ? ClaudeReasoningLevelOption : CodexReasoningLevelOption;

function formatEffortLabel(effort: string): string {
  return effort;
}

export function ReasoningTraitsPicker<T extends ReasoningEffort>({
  value,
  options,
  defaultEffort,
  onEffortChange,
  disabled,
  fastMode,
}: {
  value: T;
  options: ReasoningOption<T>[];
  defaultEffort?: T | null;
  onEffortChange: (effort: T) => void;
  disabled?: boolean;
  fastMode?: {
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.effort === value) || options[0];

  if (!current && !fastMode) {
    return null;
  }

  const currentLabel = current ? formatEffortLabel(current.effort) : null;

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        className="inline-flex max-w-[176px] items-center gap-1.5 rounded-md py-1 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        title="Change reasoning"
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {currentLabel && <span className="truncate">{currentLabel}</span>}
          {fastMode?.enabled && (
            <>
              {currentLabel && <span className="shrink-0 text-[var(--text-muted)]/70">·</span>}
              <span className="inline-flex shrink-0 items-center gap-1 text-[#b42318]">
                <Zap className="h-3 w-3" aria-hidden="true" />
                <span>Fast</span>
              </span>
            </>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="popover-surface absolute bottom-full left-0 z-20 mb-2 flex min-w-[236px] flex-col gap-0.5 p-1.5"
          >
            {options.length > 0 && (
              <>
                <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
                  Effort
                </div>
                {options.map((option) => {
                  const active = option.effort === value;
                  const label = formatEffortLabel(option.effort);
                  return (
                    <button
                      key={option.effort}
                      type="button"
                      onClick={() => {
                        onEffortChange(option.effort as T);
                        setOpen(false);
                      }}
                      title={option.description}
                      role="menuitemradio"
                      aria-checked={active}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${
                        active
                          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {label}
                        {option.effort === defaultEffort ? (
                          <span className="font-normal text-[var(--text-muted)]"> (default)</span>
                        ) : null}
                      </span>
                      {active && <Check className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />}
                    </button>
                  );
                })}
              </>
            )}

            {fastMode && (
              <>
                {options.length > 0 && <div className="my-1 border-t border-[var(--popover-border)]" />}
                <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
                  Fast Mode
                </div>
                {[
                  { label: 'Off', value: false },
                  { label: 'On', value: true },
                ].map((option) => {
                  const active = fastMode.enabled === option.value;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => {
                        fastMode.onToggle(option.value);
                        setOpen(false);
                      }}
                      role="menuitemradio"
                      aria-checked={active}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${
                        active
                          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <span>{option.label}</span>
                      {active && <Check className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
