import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentProvider } from '../types';
import { PROVIDERS } from '../utils/provider';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo />;
  }

  return null;
}

interface ProviderPickerProps {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
  disabled?: boolean;
  embedded?: boolean;
}

export function ProviderPicker({ value, onChange, disabled, embedded = false }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const current = PROVIDERS.find((p) => p.id === value) || PROVIDERS[0];

  return (
    <div className="relative no-drag">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className={`flex items-center gap-1.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          embedded
            ? `rounded-lg px-3 py-2 ${
                open
                  ? 'bg-[var(--bg-tertiary)]'
                  : 'bg-transparent hover:bg-[var(--bg-tertiary)]'
              }`
            : 'rounded-lg border border-transparent bg-[var(--bg-tertiary)] px-3 py-2 hover:bg-[var(--border)]'
        }`}
      >
        <ProviderIcon provider={current.id} />
        <span className="text-[var(--text-secondary)]">{current.label}</span>
        <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute z-30 min-w-[140px] rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg ${
              embedded ? 'right-0 top-full mt-2' : 'left-0 bottom-full mb-1'
            }`}
          >
            {PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                onClick={() => {
                  onChange(provider.id);
                  setOpen(false);
                }}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  provider.id === value
                    ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <ProviderIcon provider={provider.id} />
                  <span>{provider.label}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
