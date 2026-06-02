import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Copy, Search } from './icons';
import type { AgentProvider } from '../types';
import type { ComposerModelOption } from '../hooks/useComposerAgentSelection';
import { PROVIDERS } from '../utils/provider';
import type { CodexReasoningEffort, CodexModelConfig } from '../../shared/types';
import {
  useAgentReadiness,
  type AgentReadinessEntry,
  type AgentReadinessState,
} from '../hooks/useAgentReadiness';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import aegisAvatar from '../assets/agent-avatars/anime-avatar-03.png';
import { OpenCodeLogo } from './OpenCodeLogo';

function AgentIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'aegis') {
    return <img src={aegisAvatar} alt="" className="h-4 w-4 flex-shrink-0 rounded-full object-cover" aria-hidden="true" />;
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

function readinessDotClass(state: AgentReadinessState): string {
  switch (state) {
    case 'ready':
      return 'bg-emerald-500';
    case 'checking':
      return 'bg-[var(--text-muted)] animate-pulse';
    case 'needs_login':
    case 'needs_config':
      return 'bg-amber-500';
    case 'missing':
    case 'error':
      return 'bg-rose-500';
    default:
      return 'bg-[var(--text-muted)]';
  }
}

function readinessHint(entry: AgentReadinessEntry): string | null {
  if (entry.state === 'ready' || entry.state === 'checking') return null;
  return entry.summary;
}

export function ComposerAgentPicker({
  value,
  disabled,
  onChange,
}: {
  value: AgentProvider;
  disabled?: boolean;
  onChange: (provider: AgentProvider) => void;
}) {
  const { entries } = useAgentReadiness(null, true);
  const readinessByProvider = useMemo(() => {
    const map = new Map<AgentProvider, AgentReadinessEntry>();
    entries.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [entries]);
  const currentReadiness = readinessByProvider.get(value);
  const [copiedProvider, setCopiedProvider] = useState<AgentProvider | null>(null);

  useEffect(() => {
    if (!copiedProvider) return;
    const timer = window.setTimeout(() => setCopiedProvider(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedProvider]);

  const handleCopyCommand = async (
    event: React.MouseEvent<HTMLButtonElement>,
    provider: AgentProvider,
    command: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(command);
      setCopiedProvider(provider);
    } catch {
      // ignore — clipboard may be unavailable in sandboxed contexts
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`${triggerClassName} max-w-[190px]`}
          title={
            currentReadiness && currentReadiness.state !== 'ready'
              ? `${agentLabel(value)} — ${currentReadiness.summary}`
              : `Agent: ${agentLabel(value)}`
          }
          aria-label="Select agent"
        >
          <AgentIcon provider={value} />
          <span className="min-w-0 truncate">{agentLabel(value)}</span>
          {currentReadiness && currentReadiness.state !== 'ready' && currentReadiness.state !== 'checking' ? (
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(currentReadiness.state)}`}
              aria-hidden="true"
            />
          ) : null}
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[280px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {PROVIDERS.map((provider) => {
            const selected = provider.id === value;
            const readiness = readinessByProvider.get(provider.id);
            const hint = readiness ? readinessHint(readiness) : null;
            const command = readiness?.command ?? null;
            const showCopy =
              !!command &&
              readiness !== undefined &&
              readiness.state !== 'ready' &&
              readiness.state !== 'checking';
            const justCopied = copiedProvider === provider.id;
            return (
              <DropdownMenu.Item
                key={provider.id}
                onSelect={() => onChange(provider.id)}
                className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <AgentIcon provider={provider.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {provider.label}
                  </span>
                  {hint ? (
                    <span className="block truncate text-[11px] text-[var(--text-muted)]">
                      {hint}
                    </span>
                  ) : null}
                </span>
                {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                  <span
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`}
                    aria-hidden="true"
                  />
                ) : null}
                {showCopy ? (
                  <button
                    type="button"
                    onClick={(event) => handleCopyCommand(event, provider.id, command!)}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                    title={justCopied ? 'Copied!' : `Copy: ${command}`}
                    aria-label={justCopied ? 'Copied' : `Copy install command: ${command}`}
                  >
                    {justCopied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                ) : null}
                {selected ? <Check className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const codexEffortOptions: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

const EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
};

function reasoningEffortLabel(effort: CodexReasoningEffort): string {
  return EFFORT_LABELS[effort] || effort;
}

export function ComposerModelPicker({
  value,
  selectedKey,
  label,
  options,
  setupLabel,
  disabled,
  onSetup,
  onChange,
  // Cascading Codex props
  codexModelConfig,
  codexModels,
  codexReasoningEffort,
  onCodexReasoningEffortChange,
}: {
  value: string | null;
  selectedKey?: string | null;
  label: string;
  options: ComposerModelOption[];
  setupLabel?: string | null;
  disabled?: boolean;
  onSetup?: () => void;
  onChange: (option: ComposerModelOption) => void;
  // Cascading Codex props
  codexModelConfig?: CodexModelConfig | null;
  codexModels?: CodexModelConfig['availableModels'];
  codexReasoningEffort?: CodexReasoningEffort | null;
  onCodexReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
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

  // Derive Codex model options from config
  const codexModelOptions = useMemo(() => {
    if (!codexModelConfig || !codexModels) return [];
    return codexModels.map((m) => ({
      ...m,
      optionKey: m.name,
      optionValue: m.name,
    }));
  }, [codexModelConfig, codexModels]);

  const filteredCodexModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return codexModelOptions;
    return codexModelOptions.filter((m) =>
      m.name.toLowerCase().includes(normalizedQuery)
    );
  }, [codexModelOptions, query]);

  // Cascading Codex picker
  if (codexModelConfig && codexModels) {
    return (
      <DropdownMenu.Root onOpenChange={(open) => !open && setQuery('')}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={disabled || codexModels.length === 0}
            className={`${triggerClassName} max-w-[240px]`}
            title={`Model: ${label}${codexReasoningEffort ? ` – ${codexReasoningEffort}` : ''}`}
            aria-label="Select model"
          >
            <span className="min-w-0 truncate">
              {codexReasoningEffort
                ? `${label.replace(/^GPT-/, '')} ${codexReasoningEffort}`
                : (label || value || 'Default model')}
            </span>
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="top"
            sideOffset={8}
            className="z-50 w-[280px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
          >
            {/* Section: Reasoning Effort */}
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Reasoning effort
            </div>
            {codexEffortOptions.map((effort) => {
              const isSelected = codexReasoningEffort === effort;
              return (
                <DropdownMenu.Item
                  key={effort}
                  onSelect={() => onCodexReasoningEffortChange?.(effort)}
                  className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                      {reasoningEffortLabel(effort)}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--text-muted)]">
                      {effort === 'low' && 'Quick answers, basic reasoning'}
                      {effort === 'medium' && 'Balanced speed and depth'}
                      {effort === 'high' && 'Thorough analysis, slower'}
                      {effort === 'xhigh' && 'Maximum reasoning depth'}
                    </span>
                  </span>
                  {isSelected ? <Check className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" /> : null}
                </DropdownMenu.Item>
              );
            })}

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

            {/* Section: Models */}
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Models
            </div>
            {codexModels.length > 8 ? (
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
            <div className="max-h-[200px] overflow-y-auto">
              {filteredCodexModels.length === 0 ? (
                <div className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">No models found</div>
              ) : (
                filteredCodexModels.map((codexModel) => {
                  const option: ComposerModelOption = {
                    key: codexModel.optionKey,
                    value: codexModel.optionValue,
                    label: codexModel.name,
                  };
                  const isSelected = value === codexModel.name;
                  return (
                    <DropdownMenu.Item
                      key={codexModel.optionKey}
                      onSelect={() => onChange(option)}
                      className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                          {codexModel.name}
                        </span>
                      </span>
                      {isSelected ? <Check className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" /> : null}
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

  // Existing early return: show setup button when no options available
  if (options.length === 0 && setupLabel) {
    return (
      <button
        type="button"
        disabled={disabled || !onSetup}
        onClick={onSetup}
        className={`${triggerClassName} max-w-[240px]`}
        title={setupLabel}
        aria-label={setupLabel}
      >
        <span className="min-w-0 truncate">{setupLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
      </button>
    );
  }

  // Flat list picker (existing behavior)
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
