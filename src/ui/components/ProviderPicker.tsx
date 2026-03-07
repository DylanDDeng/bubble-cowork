import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentProvider } from '../types';
import { PROVIDERS } from '../utils/provider';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  return null;
}

interface ProviderPickerProps {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
  disabled?: boolean;
}

export function ProviderPicker({ value, onChange, disabled }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const current = PROVIDERS.find((p) => p.id === value) || PROVIDERS[0];

  return (
    <div className="relative no-drag">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--border)] border border-transparent flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ProviderIcon provider={current.id} />
        <span className="text-[var(--text-secondary)]">{current.label}</span>
        <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[140px] z-20">
            {PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                onClick={() => {
                  onChange(provider.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
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
