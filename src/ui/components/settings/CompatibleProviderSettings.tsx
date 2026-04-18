import {
  ChevronDown,
  Eye,
  EyeOff,
  LoaderCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import mimoLogo from '../../assets/xiaomimimo.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { useClaudeRuntimeStatus } from '../../hooks/useClaudeRuntimeStatus';
import { useCodexRuntimeStatus } from '../../hooks/useCodexRuntimeStatus';
import { useOpencodeRuntimeStatus } from '../../hooks/useOpencodeRuntimeStatus';
import { Badge } from '../ui/badge';
import { OpenCodeLogo } from '../OpenCodeLogo';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type {
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProvidersConfig,
  ClaudeRuntimeStatus,
  CodexRuntimeStatus,
  OpenCodeRuntimeStatus,
} from '../../types';
import { normalizeCompatibleProvidersConfig } from '../../hooks/useCompatibleProviderConfig';
import { SettingsSection } from './SettingsPrimitives';

const DEFAULT_CONFIG = normalizeCompatibleProvidersConfig(undefined);
const PROVIDER_IDS = ['minimaxCn', 'minimax', 'mimo', 'zhipu', 'moonshot', 'deepseek'] as ClaudeCompatibleProviderId[];

const PROVIDER_META: Record<
  ClaudeCompatibleProviderId,
  { label: string; logo: string; description: string }
> = {
  minimaxCn: {
    label: 'MiniMax (CN)',
    logo: minimaxLogo,
    description: 'Route Claude-compatible requests through MiniMax China.',
  },
  minimax: {
    label: 'MiniMax (Global)',
    logo: minimaxLogo,
    description: 'Route Claude-compatible requests through MiniMax global endpoints.',
  },
  mimo: {
    label: 'MiMo',
    logo: mimoLogo,
    description: 'Use Xiaomi MiMo as a Claude-compatible provider.',
  },
  zhipu: {
    label: 'Zhipu AI',
    logo: zhipuLogo,
    description: 'Use GLM-backed routing for Claude-compatible requests.',
  },
  moonshot: {
    label: 'Moonshot AI',
    logo: moonshotLogo,
    description: 'Use Kimi-compatible endpoints for Claude-compatible requests.',
  },
  deepseek: {
    label: 'DeepSeek',
    logo: deepseekLogo,
    description: 'Use DeepSeek through a Claude-compatible API surface.',
  },
};

const PROVIDER_MODEL_SUGGESTIONS: Record<
  ClaudeCompatibleProviderId,
  { model: string; smallFastModel?: string }[]
> = {
  minimaxCn: [{ model: 'MiniMax-M2.5', smallFastModel: 'MiniMax-M2.5' }],
  minimax: [{ model: 'MiniMax-M2.5', smallFastModel: 'MiniMax-M2.5' }],
  mimo: [
    { model: 'mimo-v2-pro', smallFastModel: 'mimo-v2-flash' },
    { model: 'mimo-v2-flash', smallFastModel: 'mimo-v2-flash' },
  ],
  zhipu: [
    { model: 'glm-5', smallFastModel: 'glm-5' },
    { model: 'glm-4.6', smallFastModel: 'glm-4.6' },
  ],
  moonshot: [
    { model: 'kimi-k2.5', smallFastModel: 'kimi-k2-turbo' },
    { model: 'kimi-k2-turbo', smallFastModel: 'kimi-k2-turbo' },
  ],
  deepseek: [
    { model: 'deepseek-chat', smallFastModel: 'deepseek-chat' },
    { model: 'deepseek-reasoner', smallFastModel: 'deepseek-chat' },
  ],
};

const MODEL_HISTORY_STORAGE_KEY = 'cowork.compatible-provider-model-history';

type ProviderModelHistory = Partial<
  Record<ClaudeCompatibleProviderId, { model?: string[]; smallFastModel?: string[] }>
>;

function loadProviderModelHistory(): ProviderModelHistory {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(MODEL_HISTORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ProviderModelHistory) : {};
  } catch {
    return {};
  }
}

function saveProviderModelHistory(nextHistory: ProviderModelHistory): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(MODEL_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
}

function rememberProviderModelValue(
  providerId: ClaudeCompatibleProviderId,
  field: 'model' | 'smallFastModel',
  value: string | undefined
): void {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }

  const current = loadProviderModelHistory();
  const providerHistory = current[providerId] || {};
  const existingValues = providerHistory[field] || [];
  const nextValues = [normalized, ...existingValues.filter((item) => item !== normalized)].slice(0, 12);
  current[providerId] = {
    ...providerHistory,
    [field]: nextValues,
  };
  saveProviderModelHistory(current);
}

function getProviderModelSuggestions(
  providerId: ClaudeCompatibleProviderId,
  field: 'model' | 'smallFastModel',
  draftProvider: ClaudeCompatibleProviderConfig
): string[] {
  const builtins = PROVIDER_MODEL_SUGGESTIONS[providerId]
    .map((item) => (field === 'model' ? item.model : item.smallFastModel))
    .filter((value): value is string => Boolean(value));
  const currentValue = field === 'model' ? draftProvider.model : draftProvider.smallFastModel || '';
  const history = loadProviderModelHistory()[providerId]?.[field] || [];

  return Array.from(
    new Set(
      [currentValue, ...history, ...builtins]
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [expandedProviderId, setExpandedProviderId] = useState<ClaudeCompatibleProviderId | null>(null);
  const [draftProvider, setDraftProvider] = useState<ClaudeCompatibleProviderConfig | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<{ providerId: ClaudeCompatibleProviderId; text: string; tone: 'default' | 'error' } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'baseUrl' | 'model' | 'secret', string>>>({});

  const { status: claudeRuntimeStatus, loading: claudeRuntimeLoading } = useClaudeRuntimeStatus();
  const { status: codexRuntimeStatus, loading: codexRuntimeLoading } = useCodexRuntimeStatus();
  const { status: opencodeRuntimeStatus, loading: opencodeRuntimeLoading } = useOpencodeRuntimeStatus();

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getClaudeCompatibleProviderConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(normalizeCompatibleProvidersConfig(nextConfig));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const modelSuggestions = useMemo(() => {
    if (!expandedProviderId || !draftProvider) {
      return [];
    }
    return getProviderModelSuggestions(expandedProviderId, 'model', draftProvider);
  }, [draftProvider, expandedProviderId]);

  const smallFastModelSuggestions = useMemo(() => {
    if (!expandedProviderId || !draftProvider) {
      return [];
    }
    return getProviderModelSuggestions(expandedProviderId, 'smallFastModel', draftProvider);
  }, [draftProvider, expandedProviderId]);

  const openProviderEditor = (providerId: ClaudeCompatibleProviderId) => {
    if (savingProvider) {
      return;
    }

    if (expandedProviderId === providerId) {
      setExpandedProviderId(null);
      setDraftProvider(null);
      setShowSecret(false);
      setAdvancedOpen(false);
      setErrors({});
      return;
    }

    setExpandedProviderId(providerId);
    setDraftProvider({ ...config.providers[providerId] });
    setShowSecret(false);
    setAdvancedOpen(Boolean(config.providers[providerId].smallFastModel || config.providers[providerId].maxOutputTokens));
    setErrors({});
  };

  const updateDraftProvider = (
    updater: (current: ClaudeCompatibleProviderConfig) => ClaudeCompatibleProviderConfig
  ) => {
    setDraftProvider((current) => (current ? updater(current) : current));
  };

  const validateDraftProvider = () => {
    if (!expandedProviderId || !draftProvider) {
      return false;
    }

    const nextErrors: Partial<Record<'baseUrl' | 'model' | 'secret', string>> = {};
    if (draftProvider.enabled) {
      if (!draftProvider.baseUrl.trim()) {
        nextErrors.baseUrl = 'Enter the provider endpoint URL.';
      }
      if (!draftProvider.model.trim()) {
        nextErrors.model = 'Enter the default model name.';
      }
      if (!draftProvider.secret.trim()) {
        nextErrors.secret = 'Enter the token used for this endpoint.';
      }
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSaveProvider = async () => {
    if (!expandedProviderId || !draftProvider) {
      return;
    }
    if (!validateDraftProvider()) {
      return;
    }

    setSavingProvider(expandedProviderId);
    setMessage(null);

    try {
      const nextConfig = normalizeCompatibleProvidersConfig({
        providers: {
          ...config.providers,
          [expandedProviderId]: draftProvider,
        },
      });
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(nextConfig);
      setConfig(normalizeCompatibleProvidersConfig(saved));
      rememberProviderModelValue(expandedProviderId, 'model', draftProvider.model);
      rememberProviderModelValue(expandedProviderId, 'smallFastModel', draftProvider.smallFastModel);
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      setMessage({
        providerId: expandedProviderId,
        text: 'Saved. Restart Claude sessions to apply the updated provider connection.',
        tone: 'default',
      });
    } catch (error) {
      setMessage({
        providerId: expandedProviderId,
        text: error instanceof Error ? error.message : 'Failed to save provider config.',
        tone: 'error',
      });
    } finally {
      setSavingProvider(null);
    }
  };

  const handleResetProvider = () => {
    if (!expandedProviderId || savingProvider) {
      return;
    }
    setDraftProvider({ ...config.providers[expandedProviderId] });
    setShowSecret(false);
    setAdvancedOpen(Boolean(config.providers[expandedProviderId].smallFastModel || config.providers[expandedProviderId].maxOutputTokens));
    setErrors({});
  };

  const activeProviderMessage = message && expandedProviderId && message.providerId === expandedProviderId ? message : null;

  return (
    <div className="space-y-6 pb-8">
      <SettingsSection
        title="Runtime Health"
        description="Check whether each local runtime is ready before you start configuring provider connections."
      >
        <RuntimeStatusRow
          title="Claude Code Runtime"
          logo={<img src={claudeLogo} alt="" className="h-5 w-5" aria-hidden="true" />}
          summary={claudeRuntimeLoading ? 'Checking Claude runtime…' : claudeRuntimeStatus.summary}
          detail={!claudeRuntimeLoading && !claudeRuntimeStatus.ready ? claudeRuntimeStatus.detail : undefined}
          status={buildClaudeRailStatus(claudeRuntimeStatus, claudeRuntimeLoading)}
        />
        <RuntimeStatusRow
          title="Codex CLI ACP"
          logo={<img src={openaiLogo} alt="" className="h-5 w-5" aria-hidden="true" />}
          summary={buildCodexSummary(codexRuntimeStatus, codexRuntimeLoading)}
          status={buildCodexRailStatus(codexRuntimeStatus, codexRuntimeLoading)}
        />
        <RuntimeStatusRow
          title="OpenCode ACP"
          logo={<OpenCodeLogo className="h-5 w-5 flex-shrink-0" />}
          summary={buildOpencodeSummary(opencodeRuntimeStatus, opencodeRuntimeLoading)}
          status={buildOpencodeRailStatus(opencodeRuntimeStatus, opencodeRuntimeLoading)}
        />
      </SettingsSection>

      <SettingsSection
        title="Claude-Compatible Providers"
        description="Manage the remote endpoints Claude Code can use. Edit connections inline and keep runtime context visible."
      >
        {PROVIDER_IDS.map((providerId) => {
          const provider = config.providers[providerId];
          const meta = PROVIDER_META[providerId];
          const expanded = expandedProviderId === providerId;
          const providerDraft = expanded ? draftProvider : null;
          const providerBusy = savingProvider === providerId;
          const isDirty =
            expanded && providerDraft
              ? JSON.stringify(providerDraft) !== JSON.stringify(provider)
              : false;

          return (
            <SettingsSurfaceRow
              key={providerId}
              title={<RowTitleWithLogo logo={<img src={meta.logo} alt="" className="h-5 w-5" aria-hidden="true" />} title={meta.label} />}
              description={
                <div className="space-y-1">
                  <div>{meta.description}</div>
                  <div className="text-[12px] text-[var(--text-muted)]">{buildProviderSummary(provider)}</div>
                </div>
              }
              right={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <StateBadge
                    label={provider.enabled ? 'Enabled' : 'Disabled'}
                    variant={provider.enabled ? 'accent' : 'muted'}
                  />
                  <MetaBadge label={provider.baseUrl.trim() ? 'Configured' : 'Needs setup'} />
                  <button
                    type="button"
                    onClick={() => openProviderEditor(providerId)}
                    disabled={loading || savingProvider !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60"
                    aria-expanded={expanded}
                  >
                    <span>{expanded ? 'Collapse' : 'Edit'}</span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              }
              expanded={expanded}
            >
              {providerDraft ? (
                <div className="space-y-5">
                  <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <FieldBlock
                      label="Provider Status"
                      description="Enable this connection when you want Claude Code to route requests through it."
                    >
                      <button
                        type="button"
                        onClick={() =>
                          updateDraftProvider((current) => ({
                            ...current,
                            enabled: !current.enabled,
                          }))
                        }
                        disabled={providerBusy}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60 ${
                          providerDraft.enabled
                            ? 'border-transparent bg-[var(--accent)]'
                            : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
                        }`}
                        aria-pressed={providerDraft.enabled}
                        aria-label={providerDraft.enabled ? 'Disable provider' : 'Enable provider'}
                      >
                        <span
                          className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                            providerDraft.enabled ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </FieldBlock>

                    <FieldBlock
                      label="Base URL"
                      description="The endpoint Claude Code will call for this provider."
                      error={errors.baseUrl}
                    >
                      <input
                        value={providerDraft.baseUrl}
                        onChange={(event) => {
                          setErrors((current) => ({ ...current, baseUrl: undefined }));
                          updateDraftProvider((current) => ({
                            ...current,
                            baseUrl: event.target.value,
                          }));
                        }}
                        placeholder="https://your-compatible-endpoint/v1"
                        className={getInputClassName(Boolean(errors.baseUrl))}
                        disabled={providerBusy}
                      />
                    </FieldBlock>
                  </div>

                  <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <FieldBlock
                      label="Default Model"
                      description="The main model name sent to this provider."
                      error={errors.model}
                    >
                      <SuggestionInput
                        value={providerDraft.model}
                        onChange={(value) => {
                          setErrors((current) => ({ ...current, model: undefined }));
                          updateDraftProvider((current) => ({
                            ...current,
                            model: value,
                          }));
                        }}
                        suggestions={modelSuggestions}
                        placeholder={getProviderModelPlaceholder(providerId)}
                        disabled={providerBusy}
                      />
                    </FieldBlock>

                    <FieldBlock
                      label="Endpoint Token"
                      description="Stored locally and sent as the bearer token for this endpoint."
                      error={errors.secret}
                    >
                      <div className="relative">
                        <input
                          type={showSecret ? 'text' : 'password'}
                          value={providerDraft.secret}
                          onChange={(event) => {
                            setErrors((current) => ({ ...current, secret: undefined }));
                            updateDraftProvider((current) => ({
                              ...current,
                              authType: 'auth_token',
                              secret: event.target.value,
                            }));
                          }}
                          placeholder="token..."
                          className={getInputClassName(Boolean(errors.secret), true)}
                          disabled={providerBusy}
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecret((current) => !current)}
                          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                          aria-label={showSecret ? 'Hide token' : 'Show token'}
                          disabled={providerBusy}
                        >
                          {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </FieldBlock>
                  </div>

                  <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)]">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen((current) => !current)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                      aria-expanded={advancedOpen}
                    >
                      <div>
                        <div className="text-[13px] font-medium text-[var(--text-primary)]">Advanced</div>
                        <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
                          Optional overrides for fast fallback requests and output limits.
                        </div>
                      </div>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <div
                      className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ${
                        advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="grid gap-5 border-t border-[var(--border)] px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                          <FieldBlock
                            label="Small Fast Model"
                            description="Optional lower-latency model for lightweight Claude requests."
                          >
                            <SuggestionInput
                              value={providerDraft.smallFastModel || ''}
                              onChange={(value) =>
                                updateDraftProvider((current) => ({
                                  ...current,
                                  smallFastModel: value,
                                }))
                              }
                              suggestions={smallFastModelSuggestions}
                              placeholder="Optional override"
                              disabled={providerBusy}
                            />
                          </FieldBlock>

                          <FieldBlock
                            label="Max Output Tokens"
                            description="Optional output token limit passed through to the provider."
                          >
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={providerDraft.maxOutputTokens ?? ''}
                              onChange={(event) =>
                                updateDraftProvider((current) => ({
                                  ...current,
                                  maxOutputTokens: event.target.value
                                    ? Math.max(1, Math.trunc(Number(event.target.value)))
                                    : undefined,
                                }))
                              }
                              placeholder="Optional override"
                              className={getInputClassName(false)}
                              disabled={providerBusy}
                            />
                          </FieldBlock>
                        </div>
                      </div>
                    </div>
                  </div>

                  {activeProviderMessage ? (
                    <InlineMessage tone={activeProviderMessage.tone}>
                      {activeProviderMessage.text}
                    </InlineMessage>
                  ) : null}

                  <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
                    <div className="text-[12px] text-[var(--text-muted)]">
                      {isDirty ? 'Unsaved changes' : 'Saved and in sync'}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleResetProvider}
                        disabled={!isDirty || providerBusy}
                        className="inline-flex h-9 items-center rounded-[var(--radius-lg)] border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveProvider}
                        disabled={!isDirty || providerBusy}
                        className="inline-flex h-9 items-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                      >
                        {providerBusy ? 'Saving...' : 'Save Provider'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </SettingsSurfaceRow>
          );
        })}
      </SettingsSection>
    </div>
  );
}

function RuntimeStatusRow({
  title,
  logo,
  summary,
  detail,
  status,
}: {
  title: string;
  logo: ReactNode;
  summary: string;
  detail?: string;
  status: { label: string; tone: string; dot: string };
}) {
  return (
    <SettingsSurfaceRow
      title={<RowTitleWithLogo logo={logo} title={title} />}
      description={
        <div className="space-y-1">
          <div>{summary}</div>
          {detail ? <div className="text-[12px] text-[var(--text-muted)]">{detail}</div> : null}
        </div>
      }
      right={<StatusBadge label={status.label} toneClassName={status.tone} dotClassName={status.dot} />}
    />
  );
}

function SettingsSurfaceRow({
  title,
  description,
  right,
  expanded = false,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  right?: ReactNode;
  expanded?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
          <div className="mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
        </div>
        {right ? <div className="flex items-start justify-end">{right}</div> : <div />}
      </div>

      {children ? (
        <div
          className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-200 ${
            expanded ? 'mt-4 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            {expanded ? <div className="border-t border-[var(--border)] pt-4">{children}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RowTitleWithLogo({
  logo,
  title,
}: {
  logo: ReactNode;
  title: string;
}) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-5 w-5 items-center justify-center">{logo}</span>
      <span>{title}</span>
    </span>
  );
}

function FieldBlock({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
      <div className="mb-2 text-[12px] leading-5 text-[var(--text-muted)]">{description}</div>
      {children}
      {error ? <div className="mt-1.5 text-[12px] text-[var(--error)]">{error}</div> : null}
    </div>
  );
}

function SuggestionInput({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-[var(--radius-lg)] border-[var(--border)] bg-[var(--bg-primary)] pr-11 text-sm text-[var(--text-primary)] focus-visible:ring-[var(--accent)]"
        disabled={disabled}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            disabled={disabled}
            aria-label="Open model suggestions"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[320px]">
          {suggestions.length > 0 ? (
            suggestions.map((suggestion) => (
              <DropdownMenuItem key={suggestion} onSelect={() => onChange(suggestion)}>
                {suggestion}
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-[var(--text-muted)]">No suggestions yet.</div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InlineMessage({
  tone,
  children,
}: {
  tone: 'default' | 'error';
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border px-4 py-3 text-sm ${
        tone === 'error'
          ? 'border-[var(--error)]/25 bg-[var(--bg-secondary)] text-[var(--error)]'
          : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
      }`}
    >
      {children}
    </div>
  );
}

function StatusBadge({
  label,
  toneClassName,
  dotClassName,
}: {
  label: string;
  toneClassName: string;
  dotClassName: string;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] px-2.5 text-[12px] font-medium">
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} />
      <span className={toneClassName}>{label}</span>
    </span>
  );
}

function StateBadge({
  label,
  variant,
}: {
  label: string;
  variant: 'accent' | 'muted';
}) {
  return (
    <Badge
      variant={variant}
      className="border-transparent px-2.5 py-1 text-[11px] font-medium"
    >
      {label}
    </Badge>
  );
}

function MetaBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex h-8 items-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] font-medium text-[var(--text-muted)]">
      {label}
    </span>
  );
}

function buildProviderSummary(provider: ClaudeCompatibleProviderConfig): string {
  if (!provider.enabled) {
    return 'Disabled. This provider will not be offered to Claude sessions.';
  }

  const parts: string[] = [];
  if (provider.model.trim()) {
    parts.push(`Model: ${provider.model.trim()}`);
  }
  if (provider.baseUrl.trim()) {
    parts.push(`Endpoint: ${provider.baseUrl.trim()}`);
  }
  if (!provider.secret.trim()) {
    parts.push('Token missing');
  }
  return parts.length > 0 ? parts.join(' • ') : 'Enabled, but setup is incomplete.';
}

function getProviderModelPlaceholder(providerId: ClaudeCompatibleProviderId): string {
  switch (providerId) {
    case 'minimaxCn':
    case 'minimax':
      return 'MiniMax-M2.5';
    case 'mimo':
      return 'mimo-v2-pro';
    case 'zhipu':
      return 'glm-5';
    case 'moonshot':
      return 'kimi-k2.5';
    case 'deepseek':
      return 'deepseek-chat or deepseek-reasoner';
    default:
      return 'Model name';
  }
}

function getInputClassName(hasError: boolean, withTrailingControl = false) {
  return `h-10 w-full rounded-[var(--radius-lg)] border bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] ${
    withTrailingControl ? 'pr-11' : ''
  } ${
    hasError
      ? 'border-[var(--error)] focus:border-[var(--error)]'
      : 'border-[var(--border)] focus:border-[var(--text-muted)]'
  }`;
}

function buildCodexSummary(status: CodexRuntimeStatus, loading: boolean): string {
  if (loading) return 'Checking Codex runtime…';
  if (status.ready) return 'Codex CLI ACP is ready.';
  if (!status.cliAvailable) return 'Codex CLI ACP was not found.';
  return 'Codex needs local setup.';
}

function buildOpencodeSummary(status: OpenCodeRuntimeStatus, loading: boolean): string {
  if (loading) return 'Checking OpenCode runtime...';
  if (status.ready) return 'OpenCode ACP is ready.';
  if (!status.cliAvailable) return 'OpenCode ACP was not found.';
  return 'OpenCode needs local setup.';
}

function buildClaudeRailStatus(status: ClaudeRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]/60',
    };
  }

  if (status.ready) {
    return {
      label: 'Connected',
      tone: 'text-emerald-700',
      dot: 'bg-emerald-500',
    };
  }

  if (status.kind === 'install_required') {
    return {
      label: 'Install',
      tone: 'text-amber-700',
      dot: 'bg-amber-500',
    };
  }

  if (status.kind === 'login_required') {
    return {
      label: 'Sign in',
      tone: 'text-amber-700',
      dot: 'bg-amber-500',
    };
  }

  return {
    label: 'Attention',
    tone: 'text-[var(--error)]',
    dot: 'bg-[var(--error)]',
  };
}

function buildCodexRailStatus(status: CodexRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]/60',
    };
  }

  if (status.ready) {
    return {
      label: 'Connected',
      tone: 'text-emerald-700',
      dot: 'bg-emerald-500',
    };
  }

  return {
    label: 'Setup',
    tone: 'text-amber-700',
    dot: 'bg-amber-500',
  };
}

function buildOpencodeRailStatus(status: OpenCodeRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]/60',
    };
  }

  if (status.ready) {
    return {
      label: 'Connected',
      tone: 'text-emerald-700',
      dot: 'bg-emerald-500',
    };
  }

  return {
    label: 'Setup',
    tone: 'text-amber-700',
    dot: 'bg-amber-500',
  };
}
