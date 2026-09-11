import { type FC, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { ReasoningEffortSlider } from './ReasoningEffortSlider';
import { toast } from 'sonner';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import { Check, ChevronDown, ChevronRight, Copy, FastModeIcon, Search, RotateCcw, Zap } from './icons';
import type { AgentProvider } from '../types';
import type { ComposerModelOption } from '../hooks/useComposerAgentSelection';
import { PROVIDERS } from '../utils/provider';
import type {
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  CodexModelConfig,
  BubbleModelConfig,
  DeepseekReasoningEffort,
  GrokModelConfig,
  GrokReasoningEffort,
  KimiThinking,
} from '../../shared/types';
import {
  GROK_REASONING_EFFORT_LABELS,
  GROK_REASONING_EFFORT_OPTIONS,
} from '../utils/grok-reasoning';
import {
  bubbleThinkingLevelsForModel,
  formatBubbleThinkingLevelLabel,
} from '../utils/bubble-reasoning';
import {
  DEEPSEEK_REASONING_EFFORT_LABELS,
  DEEPSEEK_REASONING_EFFORT_OPTIONS,
} from '../utils/deepseek-reasoning';
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
import { BubbleLogo } from './BubbleLogo';
import { QoderLogo } from './QoderLogo';
import { DeepseekLogo } from './DeepseekLogo';

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
  if (provider === 'qoder') {
    return <QoderLogo />;
  }
  if (provider === 'bubble') {
    return <BubbleLogo />;
  }
  if (provider === 'deepseek') {
    return <DeepseekLogo />;
  }
  return null;
}

function agentLabel(provider: AgentProvider): string {
  return PROVIDERS.find((item) => item.id === provider)?.label || 'Agent';
}

// `composer-pill-trigger` (index.css) supplies the hover wash plus the
// press animation — the wash widens and the label nudges right before the
// menu opens.
const triggerClassName =
  'composer-pill-trigger relative flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';
const fullModelLabelTriggerClassName = 'w-max max-w-none shrink-0 whitespace-nowrap';

// Portals retain context, so the visible provider panel can describe the
// trigger without threading presentation state through every provider adapter.
const EffortPickerTriggerContext = createContext<((hasEfforts: boolean) => void) | null>(null);

function useStablePickerTrigger() {
  const [open, setOpen] = useState(false);
  const [hasEfforts, setHasEfforts] = useState(false);
  const [width, setWidth] = useState<number>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const measurementRef = useRef<HTMLSpanElement>(null);
  const onOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const trigger = triggerRef.current;
      if (trigger) {
        // 36px covers the horizontal padding, chevron, and gap. Measure the
        // placeholder too, so even a very short model name opens without clipping.
        setWidth(Math.max(trigger.getBoundingClientRect().width,
          (measurementRef.current?.getBoundingClientRect().width ?? 0) + 36));
      }
    } else {
      setWidth(undefined);
      setHasEfforts(false);
    }
    setOpen(nextOpen);
  };
  return { open, width, triggerRef, measurementRef, onOpenChange, setHasEfforts,
    openLabel: hasEfforts ? 'Select effort' : 'Select model' };
}

function ModelEffortLabel({ model, effort, maximum = false }: {
  model: string;
  effort?: string | null;
  maximum?: boolean;
}) {
  return (
    <span className="composer-model-effort-label">
      <span className="composer-model-name">{model}</span>
      {effort && <span className="composer-model-effort" data-maximum={maximum || undefined}>{' '}{effort.trim()}</span>}
    </span>
  );
}

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

function codexEffortOptionsForModel(
  models: CodexModelConfig['availableModels'] | undefined,
  model: string | null | undefined
): CodexReasoningEffort[] {
  const matched = (models ?? []).find((entry) => entry.name === model);
  const supported = (matched?.supportedReasoningLevels ?? [])
    .map((level) => level.effort)
    .filter(Boolean);
  return supported;
}
const claudeEffortOptions: ClaudeReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const grokEffortOptions: GrokReasoningEffort[] = GROK_REASONING_EFFORT_OPTIONS;

function grokEffortOptionsForModel(
  models: GrokModelConfig['availableModels'] | undefined,
  model: string | null | undefined
): GrokReasoningEffort[] {
  const matched = (models ?? []).find((entry) => entry.name === model);
  const supported = matched?.reasoningEfforts ?? [];
  return matched?.reasoningEfforts ? supported : grokEffortOptions;
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
  const pickerTrigger = useStablePickerTrigger();
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
    return (
      <EffortPickerTriggerContext.Provider value={pickerTrigger.setHasEfforts}>
      <DropdownMenu.Root onOpenChange={pickerTrigger.onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <button
            ref={pickerTrigger.triggerRef}
            style={pickerTrigger.open ? { width: pickerTrigger.width } : undefined}
            type="button"
            disabled={disabled || codexModels.length === 0}
            className={`${triggerClassName} ${fullModelLabelTriggerClassName}`}
            title={`Model: ${label}${codexReasoningEffort ? ` – ${codexReasoningEffort}` : ''}`}
            aria-label="Select model"
          >
            <span ref={pickerTrigger.measurementRef} style={{ position: 'absolute' }} className="pointer-events-none invisible whitespace-nowrap" aria-hidden="true">Select effort</span>
            {pickerTrigger.open ? <span className="flex-1 whitespace-nowrap text-center">{pickerTrigger.openLabel}</span> : (
            <span className="flex items-center gap-1 whitespace-nowrap">
              {codexFastMode && <FastModeIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-primary)]" />}
              <ModelEffortLabel model={label || value || 'Default model'}
                effort={codexReasoningEffort ? formatCodexReasoningEffortLabel(codexReasoningEffort) : null}
                maximum={codexReasoningEffort === 'ultra'} />
            </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="top"
            sideOffset={8}
            className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
          >
            <CodexAgentSubContent
              codexModels={codexModels}
              selectedModel={value}
              codexReasoningEffort={codexReasoningEffort ?? null}
              codexFastMode={codexFastMode ?? false}
              onSelectModel={onChange}
              onCodexReasoningEffortChange={(effort) => onCodexReasoningEffortChange?.(effort)}
              onCodexFastModeChange={(enabled) => onCodexFastModeChange?.(enabled)}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      </EffortPickerTriggerContext.Provider>
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
  loadingText,
  searchable = false,
  active = true,
  keepOpen = false,
}: {
  modelOptions: ComposerModelOption[];
  selectedValue: string | null;
  onSelectModel: (option: ComposerModelOption) => void;
  loadingText?: string | null;
  searchable?: boolean;
  active?: boolean;
  keepOpen?: boolean;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (!active) setQuery(''); }, [active]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = modelOptions.filter((option) => !option.hiddenFromPicker);
  const filteredOptions = normalizedQuery
    ? visibleOptions.filter(
        (option) =>
          option.label.toLowerCase().includes(normalizedQuery) ||
          option.value.toLowerCase().includes(normalizedQuery) ||
          (option.description ?? '').toLowerCase().includes(normalizedQuery)
      )
    : visibleOptions;

  if (visibleOptions.length === 0) {
    return (
      <div className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">
        {loadingText || 'No models configured'}
      </div>
    );
  }
  const showSearch = searchable && visibleOptions.length > 8;
  const list =
    filteredOptions.length === 0 ? (
      <div className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">No models found</div>
    ) : (
      filteredOptions.map((option) => {
        const selected = (option.value.trim() || null) === (selectedValue?.trim() || null);
        return (
          <DropdownMenu.Item
            key={option.key}
            title={option.details}
            disabled={!active}
            closeOnClick={!keepOpen}
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
      })
    );

  if (!searchable) {
    return <>{list}</>;
  }

  return (
    <>
      {showSearch ? (
        <div
          className="mb-1 flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Search className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
          <input
            disabled={!active}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              // Keep menu typeahead/arrow navigation from stealing keystrokes;
              // let Escape bubble so it still closes the menu.
              if (event.key !== 'Escape') {
                event.stopPropagation();
              }
            }}
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      ) : null}
      <div className="max-h-[280px] overflow-y-auto">{list}</div>
    </>
  );
}

const panelItemClass = 'flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-tertiary)]';

function EffortModelPanel<T extends string>({
  modelOptions, selectedModel, onSelectModel, efforts, effort, onEffortChange,
  formatEffort, effortLabel = 'Reasoning', onResetEffort, loadingText, fast = false, onFastChange, preserveEffortOrder = false,
}: {
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  onSelectModel: (option: ComposerModelOption) => void;
  efforts: readonly T[];
  effort: T | null;
  onEffortChange: (value: T) => void;
  formatEffort: (value: T) => string;
  effortLabel?: string;
  onResetEffort?: () => void;
  loadingText?: string | null;
  fast?: boolean;
  onFastChange?: (value: boolean) => void;
  preserveEffortOrder?: boolean;
}) {
  const reportEfforts = useContext(EffortPickerTriggerContext);
  useLayoutEffect(() => {
    reportEfforts?.(efforts.length > 0);
    return () => reportEfforts?.(false);
  }, [reportEfforts, efforts.length]);
  const [view, setView] = useState<'compact' | 'models'>('compact');
  const [height, setHeight] = useState<number>();
  const [ready, setReady] = useState(false);
  const compact = useRef<HTMLDivElement>(null);
  const models = useRef<HTMLDivElement>(null);
  const modelButton = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const showingModels = view === 'models';
  const currentModel = modelOptions.find((option) => option.value === selectedModel);

  useLayoutEffect(() => {
    const element = showingModels ? models.current : compact.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingModels]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Restore keyboard focus after a view disappears, including model selection.
  useLayoutEffect(() => {
    if (ready) (showingModels ? backButton : modelButton).current?.focus();
  }, [showingModels, ready]);

  return (
    <div className="effort-model-views" style={{ height }} data-ready={ready} data-reduced-motion={reducedMotion || undefined}>
      <div ref={compact} className="effort-model-view" data-view="compact" aria-hidden={showingModels} inert={showingModels}>
        {efforts.length > 0 ? (
          <ReasoningEffortSlider key={selectedModel} options={efforts} value={effort}
            onChange={onEffortChange} formatLabel={formatEffort} label={effortLabel} fast={fast} inactive={showingModels} preserveOrder={preserveEffortOrder}
            renderHeader={(previewLabel) => (
              <div className="effort-picker-toolbar">
                <div className="effort-picker-toolbar-slot">
                  {onFastChange && (
                    <DropdownMenu.Item disabled={showingModels} closeOnClick={false}
                      className="effort-picker-icon-button" role="menuitemcheckbox" aria-checked={fast}
                      aria-label="Fast mode" title={fast ? 'Turn off Fast mode' : 'Fast mode · Increased usage'}
                      data-active={fast || undefined} onSelect={() => onFastChange(!fast)}>
                      {fast ? <FastModeIcon /> : <Zap />}
                    </DropdownMenu.Item>
                  )}
                </div>
                <DropdownMenu.Item ref={modelButton} disabled={showingModels} closeOnClick={false}
                  className="effort-picker-model-button" onSelect={() => setView('models')} aria-label="Choose model">
                  <span className="effort-picker-selected-effort">{previewLabel}<ChevronRight /></span>
                  <span className="effort-picker-model-name">{currentModel?.label || selectedModel || 'Choose model'}</span>
                </DropdownMenu.Item>
                <div className="effort-picker-toolbar-slot">
                  <DropdownMenu.Item disabled={showingModels || !onResetEffort} closeOnClick={false}
                    className="effort-picker-icon-button" aria-label="Reset reasoning to default" title="Reset reasoning to default"
                    onSelect={() => onResetEffort?.()}>
                    <RotateCcw className="-scale-x-100" />
                  </DropdownMenu.Item>
                </div>
              </div>
            )} />
        ) : (
          <DropdownMenu.Item ref={modelButton} disabled={showingModels} closeOnClick={false}
            className={panelItemClass} onSelect={() => setView('models')} aria-label="Choose model">
            <span className="min-w-0 flex-1 truncate">{currentModel?.label || selectedModel || 'Choose model'}</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </DropdownMenu.Item>
        )}
      </div>
      <div ref={models} className="effort-model-view" data-view="models" aria-hidden={!showingModels} inert={!showingModels}>
        <DropdownMenu.Item ref={backButton} disabled={!showingModels} closeOnClick={false}
          className={panelItemClass} onSelect={() => setView('compact')} aria-label="Back to reasoning">
          <ChevronRight className="h-3.5 w-3.5 rotate-180 text-[var(--text-muted)]" /><span>Models</span>
        </DropdownMenu.Item>
        <ModelSubContent modelOptions={modelOptions} selectedValue={selectedModel}
          onSelectModel={(option) => { onSelectModel(option); setView('compact'); }}
          loadingText={loadingText} searchable active={showingModels} keepOpen />
      </div>
    </div>
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
  return <EffortModelPanel modelOptions={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={claudeEffortOptions} effort={claudeReasoningEffort} onEffortChange={onClaudeReasoningEffortChange}
    formatEffort={(effort) => claudeEffortLabels[effort]} />;
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
  return <EffortModelPanel modelOptions={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={kimiThinkingOptions} effort={kimiThinkingChecked} onEffortChange={onKimiThinkingChange}
    formatEffort={formatKimiThinkingLabel} effortLabel="Thinking" onResetEffort={() => onKimiThinkingChange(null)} />;
};

const GrokAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  grokModels?: GrokModelConfig['availableModels'];
  grokReasoningEffort: GrokReasoningEffort | null;
  onSelectModel: (option: ComposerModelOption) => void;
  onGrokReasoningEffortChange: (effort: GrokReasoningEffort) => void;
}> = ({
  modelOptions,
  selectedModel,
  grokModels,
  grokReasoningEffort,
  onSelectModel,
  onGrokReasoningEffortChange,
}) => {
  return <EffortModelPanel modelOptions={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={grokEffortOptionsForModel(grokModels, selectedModel)} effort={grokReasoningEffort}
    onEffortChange={onGrokReasoningEffortChange} formatEffort={(effort) => grokEffortLabels[effort]} />;
};

const DeepseekAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  reasoningEffort: DeepseekReasoningEffort;
  onSelectModel: (option: ComposerModelOption) => void;
  onReasoningEffortChange: (effort: DeepseekReasoningEffort) => void;
}> = ({
  modelOptions,
  selectedModel,
  reasoningEffort,
  onSelectModel,
  onReasoningEffortChange,
}) => (
  <EffortModelPanel modelOptions={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={modelOptions.find((option) => option.value === (selectedModel || ''))?.deepseekReasoningEfforts ?? DEEPSEEK_REASONING_EFFORT_OPTIONS} effort={reasoningEffort}
    onEffortChange={onReasoningEffortChange} formatEffort={(effort) => DEEPSEEK_REASONING_EFFORT_LABELS[effort]} />
);

// Bubble shares the animated Reasoning and Model panel.
// Thinking levels come ONLY from the SDK catalog's per-model metadata —
// deliberately no fallback list: a model without metadata (e.g. a
// "Configured default" entry the catalog doesn't know) shows no Reasoning
// section and runs on the SDK's own default, rather than offering tiers we
// made up.
const BubbleAgentSubContent: FC<{
  modelOptions: ComposerModelOption[];
  selectedModel: string | null;
  bubbleModels?: BubbleModelConfig['availableModels'];
  thinkingLevel: string | null;
  modelsLoading: boolean;
  onSelectModel: (option: ComposerModelOption) => void;
  onThinkingLevelChange: (level: string) => void;
}> = ({
  modelOptions,
  selectedModel,
  bubbleModels,
  thinkingLevel,
  modelsLoading,
  onSelectModel,
  onThinkingLevelChange,
}) => {
  const levels = bubbleThinkingLevelsForModel(bubbleModels, selectedModel);
  return <EffortModelPanel modelOptions={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={levels} effort={thinkingLevel} onEffortChange={onThinkingLevelChange}
    formatEffort={formatBubbleThinkingLevelLabel} loadingText={modelsLoading ? 'Loading models…' : null} />;
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
  const selectedConfig = models.find((entry) => entry.name === selectedModel);
  const defaultEffort = selectedConfig?.defaultReasoningEffort;
  const canResetEffort = defaultEffort != null && codexEffortOptionsForModel(models, selectedModel).includes(defaultEffort);
  const supportsFastMode = models.find((entry) => entry.name === selectedModel)?.supportsFastMode === true;
  return <EffortModelPanel
    modelOptions={models.map((codexModel) => ({ key: `codex:${codexModel.name}`, value: codexModel.name, label: formatCodexModelLabel(codexModel.name, codexModel.label) }))}
    selectedModel={selectedModel} onSelectModel={onSelectModel}
    efforts={codexEffortOptionsForModel(models, selectedModel)} effort={codexReasoningEffort}
    onEffortChange={onCodexReasoningEffortChange} formatEffort={formatCodexReasoningEffortLabel} preserveEffortOrder
    onResetEffort={canResetEffort ? () => onCodexReasoningEffortChange(defaultEffort) : undefined}
    fast={supportsFastMode && codexFastMode} onFastChange={supportsFastMode ? onCodexFastModeChange : undefined} />;
};

export function ComposerAgentModelPicker({
  agentProvider,
  modelLabel,
  modelValue,
  modelValueByProvider,
  allAgentModelOptions,
  disabled,
  onAgentChange,
  onModelChange,
  // Agent-specific props
  codexModels,
  grokModels,
  bubbleModels,
  claudeReasoningEffort,
  onClaudeReasoningEffortChange,
  codexReasoningEffort,
  onCodexReasoningEffortChange,
  grokReasoningEffort,
  onGrokReasoningEffortChange,
  bubbleThinkingLevel,
  onBubbleThinkingLevelChange,
  deepseekReasoningEffort,
  onDeepseekReasoningEffortChange,
  codexFastMode,
  onCodexFastModeChange,
  kimiThinkingOptions,
  kimiThinkingChecked,
  onKimiThinkingChange,
  menuSide = 'top',
  bubbleModelsLoading = false,
}: {
  agentProvider: AgentProvider;
  modelLabel: string;
  modelValue: string | null;
  modelValueByProvider: Record<AgentProvider, string | null>;
  allAgentModelOptions: Record<string, ComposerModelOption[]>;
  disabled?: boolean;
  onAgentChange: (provider: AgentProvider) => void;
  onModelChange: (option: ComposerModelOption, provider?: AgentProvider) => void;
  codexModels?: CodexModelConfig['availableModels'];
  grokModels?: GrokModelConfig['availableModels'];
  bubbleModels?: BubbleModelConfig['availableModels'];
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  onClaudeReasoningEffortChange?: (effort: ClaudeReasoningEffort) => void;
  codexReasoningEffort?: CodexReasoningEffort | null;
  onCodexReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
  grokReasoningEffort?: GrokReasoningEffort | null;
  onGrokReasoningEffortChange?: (effort: GrokReasoningEffort) => void;
  bubbleThinkingLevel?: string | null;
  onBubbleThinkingLevelChange?: (level: string) => void;
  deepseekReasoningEffort?: DeepseekReasoningEffort;
  onDeepseekReasoningEffortChange?: (effort: DeepseekReasoningEffort) => void;
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
  /** True while the first Bubble catalog load is in flight. */
  bubbleModelsLoading?: boolean;
}) {
  const pickerTrigger = useStablePickerTrigger();
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
  const bubbleEffortSuffix = agentProvider === 'bubble' && bubbleThinkingLevel
    ? ` ${formatBubbleThinkingLevelLabel(bubbleThinkingLevel)}`
    : '';
  const deepseekEffortSuffix = agentProvider === 'deepseek' && deepseekReasoningEffort
    ? ` ${DEEPSEEK_REASONING_EFFORT_LABELS[deepseekReasoningEffort]}`
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
  const effortSuffix =
    claudeEffortSuffix ||
    codexEffortSuffix ||
    grokEffortSuffix ||
    bubbleEffortSuffix ||
    deepseekEffortSuffix ||
    kimiThinkingSuffix;

  return (
    <EffortPickerTriggerContext.Provider value={pickerTrigger.setHasEfforts}>
    <DropdownMenu.Root onOpenChange={pickerTrigger.onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={pickerTrigger.triggerRef}
          style={pickerTrigger.open ? { width: pickerTrigger.width } : undefined}
          type="button"
          disabled={disabled}
          className={`${triggerClassName} ${fullModelLabelTriggerClassName}`}
          title={
            currentReadiness && currentReadiness.state !== 'ready'
              ? `${agentLabel(agentProvider)} — ${currentReadiness.summary}`
              : `${agentLabel(agentProvider)} / ${modelLabel}${effortSuffix}${
                  agentProvider === 'codex' && codexFastMode ? ' – Fast mode' : ''
                }`
          }
          aria-label="Select agent and model"
        >
          <span ref={pickerTrigger.measurementRef} style={{ position: 'absolute' }} className="pointer-events-none invisible whitespace-nowrap" aria-hidden="true">Select effort</span>
          {pickerTrigger.open ? <span className="flex-1 whitespace-nowrap text-center">{pickerTrigger.openLabel}</span> : <>
          <AgentIcon provider={agentProvider} />
          {agentProvider === 'codex' && codexFastMode ? (
            <FastModeIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-primary)]" aria-hidden="true" />
          ) : null}
          <ModelEffortLabel model={modelLabel} effort={effortSuffix}
            maximum={agentProvider === 'codex' && codexReasoningEffort === 'ultra'} />
          {currentReadiness && currentReadiness.state !== 'ready' && currentReadiness.state !== 'checking' ? (
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${readinessDotClass(currentReadiness.state)}`}
              aria-hidden="true"
            />
          ) : null}
          </>}
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <ClaudeAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValueByProvider[provider]}
                        claudeReasoningEffort={claudeReasoningEffort ?? null}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onClaudeReasoningEffortChange={(effort) => onClaudeReasoningEffortChange?.(effort)}
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <CodexAgentSubContent
                        codexModels={codexModels}
                        selectedModel={modelValueByProvider[provider]}
                        codexReasoningEffort={codexReasoningEffort ?? null}
                        codexFastMode={codexFastMode ?? false}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onCodexReasoningEffortChange={(effort) => onCodexReasoningEffortChange?.(effort)}
                        onCodexFastModeChange={(enabled) => onCodexFastModeChange?.(enabled)}
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <GrokAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValueByProvider[provider]}
                        grokModels={grokModels}
                        grokReasoningEffort={grokReasoningEffort ?? null}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onGrokReasoningEffortChange={(effort) => onGrokReasoningEffortChange?.(effort)}
                      />
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            }

            if (provider === 'deepseek') {
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <DeepseekAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValueByProvider[provider]}
                        reasoningEffort={deepseekReasoningEffort ?? 'max'}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onReasoningEffortChange={(effort) => {
                          onAgentChange(provider);
                          onDeepseekReasoningEffortChange?.(effort);
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <KimiAgentSubContent
                        modelOptions={modelOptions}
                        kimiThinkingOptions={kimiThinkingOptions ?? []}
                        kimiThinkingChecked={kimiThinkingChecked ?? null}
                        selectedModel={modelValueByProvider[provider]}
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

            // Bubble: per-model thinking levels + searchable model list
            if (provider === 'bubble') {
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
                      className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                    >
                      <BubbleAgentSubContent
                        modelOptions={modelOptions}
                        selectedModel={modelValueByProvider[provider]}
                        bubbleModels={bubbleModels}
                        thinkingLevel={bubbleThinkingLevel ?? null}
                        modelsLoading={bubbleModelsLoading}
                        onSelectModel={(option) => handleAgentAndModelChange(provider, option)}
                        onThinkingLevelChange={(level) => onBubbleThinkingLevelChange?.(level)}
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
                    className="z-50 w-[256px] overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)]"
                  >
                    <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
                      Models
                    </div>
                    <div className="max-h-[280px] overflow-y-auto">
                      <ModelSubContent
                        modelOptions={modelOptions}
                        selectedValue={modelValueByProvider[provider]}
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
    </EffortPickerTriggerContext.Provider>
  );
}
