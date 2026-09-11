import { useEffect, useState } from 'react';
import * as DropdownMenu from './ui/dropdown-menu';
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
  useEffect(() => { if (disabled || readOnly) setOpen(false); }, [disabled, readOnly]);
  const current = DEEPSEEK_AGENT_PRESET_OPTIONS.find((option) => option.value === value);

  return (
    <DropdownMenu.Root open={open && !(disabled || readOnly)} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
      <button
        type="button"
        disabled={disabled || readOnly}
        data-composer-control="preset"
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

      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={menuSide} align="start" sideOffset={8}
          className="flex w-[260px] max-w-[calc(100vw-32px)] flex-col p-1">
          {DEEPSEEK_AGENT_PRESET_OPTIONS.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => { if (!disabled && !readOnly) onChange?.(option.value); }}
              className={`flex-col items-start rounded-lg px-3 py-2 text-left outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] ${
                option.value === value
                  ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)]'
              }`}>
              <span className="block text-[13px] font-semibold">{option.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">{option.description}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
