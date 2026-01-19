import { useState } from 'react';
import type { AgentProvider } from '../types';
import { PROVIDERS } from '../utils/provider';

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
        <span className="text-[var(--text-secondary)]">{current.label}</span>
        <ChevronDownIcon />
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
                {provider.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="w-4 h-4 text-[var(--text-muted)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}
