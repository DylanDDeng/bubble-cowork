import { useState } from 'react';
import type { DeepseekAgentPreset } from '../types';

export const DEEPSEEK_AGENT_PRESET_OPTIONS: ReadonlyArray<{
  value: DeepseekAgentPreset;
  label: string;
  description: string;
}> = [
  {
    value: 'standard',
    label: 'Standard',
    description: 'Full coding agent with search, Skills, goals and subagents',
  },
  {
    value: 'code',
    label: 'PTC',
    description: 'Compose tool operations through a TypeScript run_code program',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    description: 'Persistent Bash and str_replace_editor only',
  },
  {
    value: 'cordis',
    label: 'Creator',
    description: 'Standard capabilities plus live Cordis runtime tools',
  },
];

export function DeepseekAgentPresetPicker({
  value,
  onChange,
  disabled,
  readOnly = false,
  menuSide = 'top',
}: {
  value: DeepseekAgentPreset;
  onChange?: (value: DeepseekAgentPreset) => void;
  disabled?: boolean;
  readOnly?: boolean;
  menuSide?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const current = DEEPSEEK_AGENT_PRESET_OPTIONS.find((option) => option.value === value);

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled || readOnly}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Select DeepSeek Harness agent mode"
        title={readOnly ? 'Agent mode is fixed for this session' : 'DeepSeek Harness agent mode for this new session'}
        className={`inline-flex items-center rounded-lg px-1.5 py-1 text-[12px] font-medium text-[var(--text-muted)] transition-colors ${
          readOnly
            ? 'cursor-default'
            : 'hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50'
        }`}
      >
        {current?.label ?? 'Standard'}
      </button>

      {open && !disabled && !readOnly ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`popover-surface absolute left-0 z-20 flex w-[260px] flex-col p-1 ${
              menuSide === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
            }`}
          >
            {DEEPSEEK_AGENT_PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange?.(option.value);
                  setOpen(false);
                }}
                className={`rounded-lg px-3 py-2 text-left transition-colors ${
                  option.value === value
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span className="block text-[13px] font-semibold">{option.label}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
