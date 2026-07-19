import { type FC, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import { Check, ChevronDown, ChevronRight, Copy, FastModeIcon, Search } from './icons';
import type { AgentProvider } from '../types';
import type { ComposerModelOption } from '../hooks/useComposerAgentSelection';
import { PROVIDERS } from '../utils/provider';
import type {
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  CodexModelConfig,
  GrokReasoningEffort,
  KimiThinking,
} from '../../shared/types';
import {
  GROK_REASONING_EFFORT_LABELS,
  GROK_REASONING_EFFORT_OPTIONS,
} from '../utils/grok-reasoning';
import { formatCodexModelLabel } from '../utils/codex-model';
import { formatCodexReasoningEffortLabel } from '../utils/codex-reasoning';
import {
  useAgentReadiness,
  type AgentReadinessEntry,
  type AgentReadinessState,
} from '../hooks/useAgentReadiness';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import moonshotLogo from '../assets/moonshot.svg';
import grokLogo from '../assets/grok.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
import { PiLogo } from './PiLogo';

export function AgentIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'opencode') {
    return <OpenCodeLogo />;
  }
  if (provider === 'kimi') {
    return <img src={moonshotLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'grok') {
    return <img src={grokLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  if (provider === 'pi') {
    return <PiLogo />;
  }
  return null;
}

function agentLabel(provider: AgentProvider): string {
  return PROVIDERS.find((item) => item.id === provider)?.label || 'Agent';
}

const triggerClassName =
  'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';

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

// Selecting an agent that isn't ready is allowed (statuses can be stale), but
// surface what setup is still needed instead of failing later on send.
function notifySetupNeeded(entry: AgentReadinessEntry | undefined): void {
  if (!entry || entry.state === 'ready' || entry.state === 'checking') return;
  toast.warning(`${entry.label}: ${entry.summary}`, {
    description: entry.command ? `Run: ${entry.command}` : entry.detail,
  });
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
                onSelect={() => {
                  notifySetupNeeded(readiness);
                  onChange(provider.id);
                }}
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

// Fallback only — real options come from the selected model's cached
// supported_reasoning_levels (see codexEffortOptionsForModel).
const codexEffortOptions: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function codexEffortOptionsForModel(
  models: CodexModelConfig['availableModels'] | undefined,
  model: string | null | undefined
): CodexReasoningEffort[] {
  const matched = (models ?? []).find((entry) => entry.name === model);
  const supported = (matched?.supportedReasoningLevels ?? [])
    .map((level) => level.effort)
    .filter(Boolean);
  return supported.length > 0 ? supported : codexEffortOptions;
}
const claudeEffortOptions: ClaudeReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const grokEffortOptions: GrokReasoningEffort[] = GROK_REASONING_EFFORT_OPTIONS;

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
  codexFastMode,
  onCodexFastModeChange,
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
  codexFastMode?: boolean;
  onCodexFastModeChange?: (enabled: boolean) => void;
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

  // Cascading Codex picker — ChatGPT-style compact cascading menu
  if (codexModelConfig && codexModels) {
    const effortOptions = codexEffortOptionsForModel(codexModels, value);

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
            <span className="flex min-w-0 items-center gap-1 truncate">
              {codexFastMode && <FastModeIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-primary)]" />}
              <span className="truncate">
                {codexReasoningEffort
                  ? `${label} ${formatCodexReasoningEffortLabel(codexReasoningEffort)}`
                  : (label || value || 'Default model')}
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="top"
            sideOffset={8}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            {/* Section: Reasoning Effort */}
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Reasoning
            </div>
            {effortOptions.map((effort) => {
              const isSelected = codexReasoningEffort === effort;
              return (
                <DropdownMenu.Item
                  key={effort}
                  onSelect={() => onCodexReasoningEffortChange?.(effort)}
                  className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                    {formatCodexReasoningEffortLabel(effort)}
                  </span>
                  {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
                </DropdownMenu.Item>
              );
            })}

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

            {/* Model submenu trigger */}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
                <span className="flex min-w-0 flex-1 items-center">
                  <span className="truncate text-[12px] text-[var(--text-primary)]">
                    {label || value || 'Model'}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={6}
                  alignOffset={-4}
                  className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                >
                  <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
                    Models
                  </div>
                  <div className="max-h-[240px] overflow-y-auto">
                    {codexModels.map((codexModel) => {
                      const option: ComposerModelOption = {
                        key: codexModel.name,
                        value: codexModel.name,
                        label: codexModel.name,
                      };
                      const isSelected = value === codexModel.name;
                      return (
                        <DropdownMenu.Item
                          key={codexModel.name}
                          onSelect={() => onChange(option)}
                          className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-[var(--text-primary)]">
                              {codexModel.name}
                            </span>
                          </span>
                          {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
                        </DropdownMenu.Item>
                      );
                    })}
                  </div>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>

            {/* Speed submenu trigger */}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                  Speed
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={6}
                  alignOffset={-4}
                  className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                >
                  <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
                    Speed
                  </div>
                  {/* Standard */}
                  <DropdownMenu.Item
                    onSelect={() => onCodexFastModeChange?.(false)}
                    className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-[var(--text-primary)]">
                        Standard
                      </span>
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        Default speed
                      </span>
                    </span>
                    {!codexFastMode ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
                  </DropdownMenu.Item>
                  {/* Fast */}
                  <DropdownMenu.Item
                    onSelect={() => onCodexFastModeChange?.(true)}
                    className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <FastModeIcon className="h-3 w-3 text-[var(--text-primary)]" />
                        <span className="truncate text-[12px] text-[var(--text-primary)]">
                          Fast
                        </span>
                      </span>
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        1.5x speed, increased usage
                      </span>
                    </span>
                    {codexFastMode ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
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

// ─── Merged Agent+Model cascading picker ───

const claudeEffortLabels: Record<ClaudeReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

const grokEffortLabels = GROK_REASONING_EFFORT_LABELS;

function ModelSubContent({
  modelOptions,
  selectedValue,
  onSelectModel,
}: {
  modelOptions: ComposerModelOption[];
  selectedValue: string | null;
  onSelectModel: (option: ComposerModelOption) => void;
}) {
  if (modelOptions.length === 0) {
    return (
      <div className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">
        No models configured
      </div>
    );
  }
  return (
    <>
      {modelOptions.map((option) => {
        const selected = (option.value.trim() || null) === (selectedValue?.trim() || null);
        return (
          <DropdownMenu.Item
            key={option.key}
            onSelect={() => onSelectModel(option)}
            className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-[var(--text-primary)]">
                {option.label}
              </span>
              {option.description ? (
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  {option.description}
                </span>
              ) : null}
            </span>
            {selected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
          </DropdownMenu.Item>
        );
      })}
    </>
  );
}

const ClaudeAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  claudeReasoningEffort: ClaudeReasoningEffort | null;
  onSelectModel: (option: ComposerModelOption) => void;
  onClaudeReasoningEffortChange: (effort: ClaudeReasoningEffort) => void;
}> = ({
  modelOptions,
  selectedModel,
  claudeReasoningEffort,
  onSelectModel,
  onClaudeReasoningEffortChange,
}) => {
  return (
    <>
      <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
        Reasoning
      </div>
      {claudeEffortOptions.map((effort) => {
        const isSelected = claudeReasoningEffort === effort;
        return (
          <DropdownMenu.Item
            key={effort}
            onSelect={() => onClaudeReasoningEffortChange(effort)}
            className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
              {claudeEffortLabels[effort]}
            </span>
            {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
          </DropdownMenu.Item>
        );
      })}

      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
            Model
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            alignOffset={-4}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Models
            </div>
            <div className="max-h-[240px] overflow-y-auto">
              <ModelSubContent
                modelOptions={modelOptions}
                selectedValue={selectedModel}
                onSelectModel={onSelectModel}
              />
            </div>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </>
  );
};

/** 'on' → 'On', 'max' → 'Max' — tiers are open-set, so format generically. */
function formatKimiThinkingLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

const KimiAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  kimiThinkingOptions: string[];
  kimiThinkingChecked: string | null;
  onSelectModel: (option: ComposerModelOption) => void;
  onKimiThinkingChange: (value: KimiThinking | null) => void;
  selectedModel: string | null;
}> = ({
  modelOptions,
  kimiThinkingOptions,
  kimiThinkingChecked,
  onSelectModel,
  onKimiThinkingChange,
  selectedModel,
}) => {
  return (
    <>
      {kimiThinkingOptions.length > 0 ? (
        <>
          <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
            Thinking
          </div>
          <DropdownMenu.Item
            key="__default"
            onSelect={() => onKimiThinkingChange(null)}
            className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
              Default
            </span>
            {kimiThinkingChecked === null ? (
              <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
            ) : null}
          </DropdownMenu.Item>
          {kimiThinkingOptions.map((tier) => {
            const isSelected = kimiThinkingChecked === tier;
            return (
              <DropdownMenu.Item
                key={tier}
                onSelect={() => onKimiThinkingChange(tier)}
                className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                  {formatKimiThinkingLabel(tier)}
                </span>
                {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
              </DropdownMenu.Item>
            );
          })}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
        </>
      ) : null}

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
            Model
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            alignOffset={-4}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Models
            </div>
            <div className="max-h-[240px] overflow-y-auto">
              <ModelSubContent
                modelOptions={modelOptions}
                selectedValue={selectedModel}
                onSelectModel={onSelectModel}
              />
            </div>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </>
  );
};

const GrokAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  grokReasoningEffort: GrokReasoningEffort | null;
  onSelectModel: (option: ComposerModelOption) => void;
  onGrokReasoningEffortChange: (effort: GrokReasoningEffort) => void;
}> = ({
  modelOptions,
  selectedModel,
  grokReasoningEffort,
  onSelectModel,
  onGrokReasoningEffortChange,
}) => {
  return (
    <>
      <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
        Reasoning
      </div>
      {grokEffortOptions.map((effort) => {
        const isSelected = grokReasoningEffort === effort;
        return (
          <DropdownMenu.Item
            key={effort}
            onSelect={() => onGrokReasoningEffortChange(effort)}
            className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
              {grokEffortLabels[effort]}
            </span>
            {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
          </DropdownMenu.Item>
        );
      })}

      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
            Model
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            alignOffset={-4}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Models
            </div>
            <div className="max-h-[240px] overflow-y-auto">
              <ModelSubContent
                modelOptions={modelOptions}
                selectedValue={selectedModel}
                onSelectModel={onSelectModel}
              />
            </div>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </>
  );
};

const CodexAgentSubContent: FC<{
  codexModels: CodexModelConfig['availableModels'] | undefined;
  selectedModel: string | null;
  codexReasoningEffort: CodexReasoningEffort | null;
  codexFastMode: boolean;
  onSelectModel: (option: ComposerModelOption) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onCodexFastModeChange: (enabled: boolean) => void;
}> = ({
  codexModels,
  selectedModel,
  codexReasoningEffort,
  codexFastMode,
  onSelectModel,
  onCodexReasoningEffortChange,
  onCodexFastModeChange,
}) => {
  const models = codexModels ?? [];
  return (
    <>
      {/* Reasoning Effort */}
      <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
        Reasoning
      </div>
      {codexEffortOptionsForModel(models, selectedModel).map((effort) => {
        const isSelected = codexReasoningEffort === effort;
        return (
          <DropdownMenu.Item
            key={effort}
            onSelect={() => onCodexReasoningEffortChange(effort)}
            className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
              {formatCodexReasoningEffortLabel(effort)}
            </span>
            {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
          </DropdownMenu.Item>
        );
      })}

      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

      {/* Model submenu */}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
          <span className="flex min-w-0 flex-1 items-center">
            <span className="truncate text-[12px] text-[var(--text-primary)]">Model</span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            alignOffset={-4}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Models
            </div>
            <div className="max-h-[240px] overflow-y-auto">
              {models.map((codexModel) => {
                const label = formatCodexModelLabel(codexModel.name, codexModel.label);
                const option: ComposerModelOption = {
                  key: codexModel.name,
                  value: codexModel.name,
                  label,
                };
                const isSelected = selectedModel === codexModel.name;
                return (
                  <DropdownMenu.Item
                    key={codexModel.name}
                    onSelect={() => onSelectModel(option)}
                    className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="truncate text-[12px] text-[var(--text-primary)]">
                        {label}
                      </span>
                    </span>
                    {isSelected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
                  </DropdownMenu.Item>
                );
              })}
            </div>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

      {/* Speed submenu */}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)] data-[popup-open]:bg-[var(--bg-tertiary)]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
            Speed
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            alignOffset={-4}
            className="z-50 w-[200px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
              Speed
            </div>
            <DropdownMenu.Item
              onSelect={() => onCodexFastModeChange(false)}
              className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[var(--text-primary)]">
                  Standard
                </span>
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  Default speed
                </span>
              </span>
              {!codexFastMode ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => onCodexFastModeChange(true)}
              className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <FastModeIcon className="h-3 w-3 text-[var(--text-primary)]" />
                  <span className="truncate text-[12px] text-[var(--text-primary)]">
                    Fast
                  </span>
                </span>
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  1.5x speed, increased usage
                </span>
              </span>
              {codexFastMode ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" /> : null}
            </DropdownMenu.Item>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

    </>
  );
};

export function ComposerAgentModelPicker({
  agentProvider,
  modelLabel,
  modelValue,
  allAgentModelOptions,
  disabled,
  onAgentChange,
  onModelChange,
  // Agent-specific props
  codexModels,
  claudeReasoningEffort,
  onClaudeReasoningEffortChange,
  codexReasoningEffort,
  onCodexReasoningEffortChange,
  grokReasoningEffort,
  onGrokReasoningEffortChange,
  codexFastMode,
  onCodexFastModeChange,
  kimiThinkingOptions,
  kimiThinkingChecked,
  onKimiThinkingChange,
  menuSide = 'top',
}: {
  agentProvider: AgentProvider;
  modelLabel: string;
  modelValue: string | null;
  allAgentModelOptions: Record<string, ComposerModelOption[]>;
  disabled?: boolean;
  onAgentChange: (provider: AgentProvider) => void;
  onModelChange: (option: ComposerModelOption, provider?: AgentProvider) => void;
  codexModels?: CodexModelConfig['availableModels'];
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  onClaudeReasoningEffortChange?: (effort: ClaudeReasoningEffort) => void;
  codexReasoningEffort?: CodexReasoningEffort | null;
  onCodexReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
  grokReasoningEffort?: GrokReasoningEffort | null;
  onGrokReasoningEffortChange?: (effort: GrokReasoningEffort) => void;
  codexFastMode?: boolean;
  onCodexFastModeChange?: (enabled: boolean) => void;
  /** Thinking tiers valid for the selected kimi model (metadata-derived). */
  kimiThinkingOptions?: string[];
  /** The tier shown as checked (explicit choice or the model default). */
  kimiThinkingChecked?: string | null;
  onKimiThinkingChange?: (value: KimiThinking | null) => void;
  /** Which side the menu opens toward. Bottom-anchored composers open 'top'
   * (default); the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
}) {
  const { entries } = useAgentReadiness(null, true);
  const readinessByProvider = useMemo(() => {
    const map = new Map<AgentProvider, AgentReadinessEntry>();
    entries.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [entries]);
  const currentReadiness = readinessByProvider.get(agentProvider);

  const handleAgentAndModelChange = (provider: AgentProvider, option?: ComposerModelOption) => {
    if (provider !== agentProvider) {
      notifySetupNeeded(readinessByProvider.get(provider));
    }
    if (option) {
      onModelChange(option, provider);
      return;
    }
    onAgentChange(provider);
  };

  // Determine which model option is currently selected for the trigger label
  const codexEffortSuffix = agentProvider === 'codex' && codexReasoningEffort
    ? ` ${formatCodexReasoningEffortLabel(codexReasoningEffort)}`
    : '';
  const claudeEffortSuffix = agentProvider === 'claude' && claudeReasoningEffort
    ? ` ${claudeEffortLabels[claudeReasoningEffort]}`
    : '';
  const grokEffortSuffix = agentProvider === 'grok' && grokReasoningEffort
    ? ` ${grokEffortLabels[grokReasoningEffort]}`
    : '';
  const kimiThinkingSuffix =
    agentProvider === 'kimi' &&
    (kimiThinkingOptions?.length ?? 0) > 0 &&
    kimiThinkingChecked &&
    kimiThinkingChecked !== 'off'
      ? kimiThinkingChecked === 'on'
        ? ' Thinking'
        : ` ${formatKimiThinkingLabel(kimiThinkingChecked)}`
      : '';
  const effortSuffix = claudeEffortSuffix || codexEffortSuffix || grokEffortSuffix || kimiThinkingSuffix;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`${triggerClassName} max-w-[190px]`}
          title={
            currentReadiness && currentReadiness.state !== 'ready'
              ? `${agentLabel(agentProvider)} — ${currentReadiness.summary}`
              : `${agentLabel(agentProvider)} / ${modelLabel}${effortSuffix}${
                  agentProvider === 'codex' && codexFastMode ? ' – Fast mode' : ''
                }`
          }
          aria-label="Select agent and model"
        >
          <AgentIcon provider={agentProvider} />
          {agentProvider === 'codex' && codexFastMode ? (
            <FastModeIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-primary)]" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 truncate">{modelLabel}{effortSuffix}</span>
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
          side={menuSide}
          sideOffset={8}
          className="z-50 w-[220px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {PROVIDERS.map((providerItem) => {
            const provider = providerItem.id;
            const readiness = readinessByProvider.get(provider);
            const hint = readiness ? readinessHint(readiness) : null;
            const modelOptions = allAgentModelOptions[provider] ?? [];

            if (provider === 'claude') {
              return (
                <DropdownMenu.Sub key={provider}>
                  <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]">
                    <AgentIcon provider={provider} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {agentLabel(provider)}
                      </span>
                      {hint ? (
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">{hint}</span>
                      ) : null}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`} aria-hidden="true" />
                    ) : null}
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={6}
                      alignOffset={-4}
                      className="z-50 w-[220px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <ClaudeAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValue}
                        claudeReasoningEffort={claudeReasoningEffort ?? null}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onClaudeReasoningEffortChange={(effort) => {
                          onAgentChange(provider);
                          onClaudeReasoningEffortChange?.(effort);
                        }}
                      />
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            // Codex agent: cascading submenu with reasoning, model, speed
            if (provider === 'codex' && codexModels) {
              return (
                <DropdownMenu.Sub key={provider}>
                  <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]">
                    <AgentIcon provider={provider} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {agentLabel(provider)}
                      </span>
                      {hint ? (
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">{hint}</span>
                      ) : null}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`} aria-hidden="true" />
                    ) : null}
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={6}
                      alignOffset={-4}
                      className="z-50 w-[220px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <CodexAgentSubContent
                        codexModels={codexModels}
                        selectedModel={modelValue}
                        codexReasoningEffort={codexReasoningEffort ?? null}
                        codexFastMode={codexFastMode ?? false}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onCodexReasoningEffortChange={(effort) => {
                          onAgentChange(provider);
                          onCodexReasoningEffortChange?.(effort);
                        }}
                        onCodexFastModeChange={(enabled) => {
                          onAgentChange(provider);
                          onCodexFastModeChange?.(enabled);
                        }}
                      />
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            // Grok Build: same Reasoning + Model layout as Claude/Codex
            if (provider === 'grok') {
              return (
                <DropdownMenu.Sub key={provider}>
                  <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]">
                    <AgentIcon provider={provider} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {agentLabel(provider)}
                      </span>
                      {hint ? (
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">{hint}</span>
                      ) : null}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`} aria-hidden="true" />
                    ) : null}
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={6}
                      alignOffset={-4}
                      className="z-50 w-[220px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <GrokAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValue}
                        grokReasoningEffort={grokReasoningEffort ?? null}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onGrokReasoningEffortChange={(effort) => {
                          onAgentChange(provider);
                          onGrokReasoningEffortChange?.(effort);
                        }}
                      />
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            // Kimi: Thinking on/off (thinking-capable models) + Model list,
            // same layout as Claude/Grok reasoning.
            if (provider === 'kimi') {
              return (
                <DropdownMenu.Sub key={provider}>
                  <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]">
                    <AgentIcon provider={provider} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {agentLabel(provider)}
                      </span>
                      {hint ? (
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">{hint}</span>
                      ) : null}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`} aria-hidden="true" />
                    ) : null}
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={6}
                      alignOffset={-4}
                      className="z-50 w-[220px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <KimiAgentSubContent
                        modelOptions={modelOptions}
                        kimiThinkingOptions={kimiThinkingOptions ?? []}
                        kimiThinkingChecked={kimiThinkingChecked ?? null}
                        selectedModel={modelValue}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onKimiThinkingChange={(value) => {
                          onAgentChange(provider);
                          onKimiThinkingChange?.(value);
                        }}
                      />
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            // Other agents: simple submenu with model list
            return (
              <DropdownMenu.Sub key={provider}>
                <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]">
                  <AgentIcon provider={provider} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                      {agentLabel(provider)}
                    </span>
                    {hint ? (
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">{hint}</span>
                    ) : null}
                  </span>
                  {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                    <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(readiness.state)}`} aria-hidden="true" />
                  ) : null}
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={6}
                    alignOffset={-4}
                    className="z-50 w-[240px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                  >
                    <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
                      Models
                    </div>
                    <div className="max-h-[280px] overflow-y-auto">
                      <ModelSubContent
                        modelOptions={modelOptions}
                        selectedValue={modelValue}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                      />
                    </div>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
