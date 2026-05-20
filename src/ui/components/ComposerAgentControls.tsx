import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bot, Check, ChevronDown, Search } from './icons';
import type { AgentProvider } from '../types';
import type { ComposerModelOption } from '../hooks/useComposerAgentSelection';
import { PROVIDERS } from '../utils/provider';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';

function AgentIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'aegis') {
    return <Bot className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" aria-hidden="true" />;
  }
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

function agentLabel(provider: AgentProvider): string {
  return PROVIDERS.find((item) => item.id === provider)?.label || 'Agent';
}

const triggerClassName =
  'flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_76%,var(--accent)_24%)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50';

export function ComposerAgentPicker({
  value,
  disabled,
  onChange,
}: {
  value: AgentProvider;
  disabled?: boolean;
  onChange: (provider: AgentProvider) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`${triggerClassName} max-w-[190px]`}
          title={`Agent: ${agentLabel(value)}`}
          aria-label="Select agent"
        >
          <AgentIcon provider={value} />
          <span className="min-w-0 truncate">{agentLabel(value)}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[240px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {PROVIDERS.map((provider) => {
            const selected = provider.id === value;
            return (
              <DropdownMenu.Item
                key={provider.id}
                onSelect={() => onChange(provider.id)}
                className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <AgentIcon provider={provider.id} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">
                  {provider.label}
                </span>
                {selected ? <Check className="h-4 w-4 text-[var(--accent)]" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ComposerModelPicker({
  value,
  selectedKey,
  label,
  options,
  disabled,
  onChange,
}: {
  value: string | null;
  selectedKey?: string | null;
  label: string;
  options: ComposerModelOption[];
  disabled?: boolean;
  onChange: (option: ComposerModelOption) => void;
}) {
  const [query, setQuery] = useState('');
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }
    return options.filter((option) =>
      [option.label, option.value, option.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    );
  }, [options, query]);

  return (
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery('')}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled || options.length === 0}
          className={`${triggerClassName} max-w-[240px]`}
          title={`Model: ${label}`}
          aria-label="Select model"
        >
          <span className="min-w-0 truncate">{label || value || 'Default model'}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[320px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {options.length > 8 ? (
            <div className="mb-1 flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2">
              <Search className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          ) : null}

          <div className="max-h-[300px] overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">No models found</div>
            ) : (
              filteredOptions.map((option) => {
                const selected = selectedKey
                  ? option.key === selectedKey
                  : option.value === value;
                return (
                  <DropdownMenu.Item
                    key={option.key}
                    onSelect={() => onChange(option)}
                    className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {selected ? <Check className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" /> : null}
                  </DropdownMenu.Item>
                );
              })
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
