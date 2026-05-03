import { Bot, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
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
import { OpenCodeLogo } from '../OpenCodeLogo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type {
  AegisBuiltInAgentConfig,
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProvidersConfig,
  ClaudeRuntimeStatus,
  CodexRuntimeStatus,
  OpenCodeRuntimeStatus,
} from '../../types';
import {
  AEGIS_BUILT_IN_DEFAULT_MODEL,
  AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  AEGIS_BUILT_IN_PROVIDERS,
  getAegisBuiltInModel,
  getAegisBuiltInProvider,
  listAegisBuiltInModels,
  resolveAegisBuiltInModel,
} from '../../../shared/aegis-built-in-catalog';
import { normalizeCompatibleProvidersConfig } from '../../hooks/useCompatibleProviderConfig';
import { SettingsGroup, SettingsToggle } from './SettingsPrimitives';

const DEFAULT_CONFIG = normalizeCompatibleProvidersConfig(undefined);
const DEFAULT_AEGIS_PROVIDER = getAegisBuiltInProvider(AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID);
const DEFAULT_AEGIS_BUILT_IN_CONFIG: AegisBuiltInAgentConfig = {
  providerId: AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  baseUrl: DEFAULT_AEGIS_PROVIDER?.baseUrl || 'https://api.openai.com/v1',
  apiKey: '',
  model: AEGIS_BUILT_IN_DEFAULT_MODEL,
  temperature: 0.2,
};
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

function normalizeAegisBuiltInAgentConfig(raw: unknown): AegisBuiltInAgentConfig {
  const input = raw && typeof raw === 'object' ? raw as Partial<AegisBuiltInAgentConfig> : {};
  const selection = resolveAegisBuiltInModel(input.model, input.providerId);
  const provider = getAegisBuiltInProvider(selection.providerId) || DEFAULT_AEGIS_PROVIDER;
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_AEGIS_BUILT_IN_CONFIG.temperature;
  const maxOutputTokens =
    typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)
      ? Math.max(1, Math.trunc(input.maxOutputTokens))
      : undefined;

  return {
    providerId: selection.providerId,
    baseUrl: provider?.baseUrl || input.baseUrl?.trim() || DEFAULT_AEGIS_BUILT_IN_CONFIG.baseUrl,
    apiKey: input.apiKey?.trim() || '',
    model: selection.encoded,
    temperature,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

function formatAegisBuiltInModel(value: string): string {
  const selection = resolveAegisBuiltInModel(value);
  const provider = getAegisBuiltInProvider(selection.providerId);
  const model = getAegisBuiltInModel(selection.providerId, selection.modelId);
  return `${provider?.name || selection.providerId} · ${model?.name || selection.modelId}`;
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
  const [aegisConfig, setAegisConfig] = useState<AegisBuiltInAgentConfig>(DEFAULT_AEGIS_BUILT_IN_CONFIG);
  const [loading, setLoading] = useState(true);
  const [aegisExpanded, setAegisExpanded] = useState(false);
  const [aegisDraft, setAegisDraft] = useState<AegisBuiltInAgentConfig | null>(null);
  const [showAegisSecret, setShowAegisSecret] = useState(false);
  const [savingAegis, setSavingAegis] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<ClaudeCompatibleProviderId | null>(null);
  const [draftProvider, setDraftProvider] = useState<ClaudeCompatibleProviderConfig | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<{ providerId: ClaudeCompatibleProviderId; text: string; tone: 'default' | 'error' } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'baseUrl' | 'model' | 'secret', string>>>({});
  const [aegisErrors, setAegisErrors] = useState<Partial<Record<'model' | 'apiKey', string>>>({});

  const { status: claudeRuntimeStatus, loading: claudeRuntimeLoading } = useClaudeRuntimeStatus();
  const { status: codexRuntimeStatus, loading: codexRuntimeLoading } = useCodexRuntimeStatus();
  const { status: opencodeRuntimeStatus, loading: opencodeRuntimeLoading } = useOpencodeRuntimeStatus();

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      window.electron.getClaudeCompatibleProviderConfig().then((nextConfig) => {
        if (!cancelled) {
          setConfig(normalizeCompatibleProvidersConfig(nextConfig));
        }
      }),
      window.electron.getAegisBuiltInAgentConfig().then((nextConfig) => {
        if (!cancelled) {
          setAegisConfig(normalizeAegisBuiltInAgentConfig(nextConfig));
        }
      }),
    ])
      .catch((error) => {
        console.error('Failed to load provider config:', error);
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

  const openAegisEditor = () => {
    if (savingAegis) {
      return;
    }
    if (aegisExpanded) {
      setAegisExpanded(false);
      setAegisDraft(null);
      setShowAegisSecret(false);
      setAegisErrors({});
      return;
    }
    setAegisExpanded(true);
    setAegisDraft({ ...aegisConfig });
    setShowAegisSecret(false);
    setAegisErrors({});
  };

  const updateAegisDraft = (
    updater: (current: AegisBuiltInAgentConfig) => AegisBuiltInAgentConfig
  ) => {
    setAegisDraft((current) => (current ? updater(current) : current));
  };

  const validateAegisDraft = () => {
    if (!aegisDraft) {
      return false;
    }
    const nextErrors: Partial<Record<'model' | 'apiKey', string>> = {};
    if (!aegisDraft.model.trim()) {
      nextErrors.model = 'Choose the default model.';
    }
    setAegisErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSaveAegisConfig = async () => {
    if (!aegisDraft || !validateAegisDraft()) {
      return;
    }
    setSavingAegis(true);
    try {
      const saved = await window.electron.saveAegisBuiltInAgentConfig(
        normalizeAegisBuiltInAgentConfig(aegisDraft)
      );
      setAegisConfig(normalizeAegisBuiltInAgentConfig(saved));
      window.dispatchEvent(new CustomEvent('aegis-built-in-agent-config-updated'));
      toast.success('Aegis Built-in Agent saved. Restart running built-in sessions to apply.');
      setAegisExpanded(false);
      setAegisDraft(null);
      setShowAegisSecret(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Aegis Built-in Agent.');
    } finally {
      setSavingAegis(false);
    }
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
      const merged: ClaudeCompatibleProviderConfig = {
        ...draftProvider,
        enabled: config.providers[expandedProviderId].enabled,
      };
      const nextConfig = normalizeCompatibleProvidersConfig({
        providers: {
          ...config.providers,
          [expandedProviderId]: merged,
        },
      });
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(nextConfig);
      setConfig(normalizeCompatibleProvidersConfig(saved));
      rememberProviderModelValue(expandedProviderId, 'model', draftProvider.model);
      rememberProviderModelValue(expandedProviderId, 'smallFastModel', draftProvider.smallFastModel);
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      toast.success('Provider saved. Restart Claude sessions to apply.');
      setExpandedProviderId(null);
      setDraftProvider(null);
      setShowSecret(false);
      setAdvancedOpen(false);
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

  const handleToggleEnabled = async (providerId: ClaudeCompatibleProviderId, nextEnabled: boolean) => {
    if (savingProvider) {
      return;
    }

    const updated: ClaudeCompatibleProviderConfig = {
      ...config.providers[providerId],
      enabled: nextEnabled,
    };
    const nextConfig = normalizeCompatibleProvidersConfig({
      providers: { ...config.providers, [providerId]: updated },
    });

    const previous = config;
    setConfig(nextConfig);
    if (expandedProviderId === providerId && draftProvider) {
      setDraftProvider({ ...draftProvider, enabled: nextEnabled });
    }

    try {
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(nextConfig);
      setConfig(normalizeCompatibleProvidersConfig(saved));
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
    } catch (error) {
      setConfig(previous);
      toast.error(error instanceof Error ? error.message : 'Failed to update provider.');
    }
  };

  const activeProviderMessage = message && expandedProviderId && message.providerId === expandedProviderId ? message : null;
  const aegisConfigured = Boolean(aegisConfig.providerId.trim() && aegisConfig.model.trim());
  const aegisNeedsKey = aegisConfig.apiKey.trim().length === 0;

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup title="Runtime Health">
        <RuntimeStatusRow
          title="Aegis Built-in"
          logo={<Bot className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />}
          detail={aegisNeedsKey ? 'Add a key below, or provide a matching provider key in the app environment.' : undefined}
          status={
            aegisConfigured
              ? { label: 'Configured', tone: 'text-emerald-700', dot: 'bg-emerald-500' }
              : { label: 'Setup', tone: 'text-amber-700', dot: 'bg-amber-500' }
          }
        />
        <RuntimeStatusRow
          title="Claude Code"
          logo={<img src={claudeLogo} alt="" className="h-5 w-5" aria-hidden="true" />}
          detail={!claudeRuntimeLoading && !claudeRuntimeStatus.ready ? claudeRuntimeStatus.detail : undefined}
          status={buildClaudeRailStatus(claudeRuntimeStatus, claudeRuntimeLoading)}
        />
        <RuntimeStatusRow
          title="Codex CLI"
          logo={<img src={openaiLogo} alt="" className="h-5 w-5" aria-hidden="true" />}
          detail={!codexRuntimeLoading && !codexRuntimeStatus.ready ? buildCodexSummary(codexRuntimeStatus, codexRuntimeLoading) : undefined}
          status={buildCodexRailStatus(codexRuntimeStatus, codexRuntimeLoading)}
        />
        <RuntimeStatusRow
          title="OpenCode"
          logo={<OpenCodeLogo className="h-5 w-5 flex-shrink-0" />}
          detail={!opencodeRuntimeLoading && !opencodeRuntimeStatus.ready ? buildOpencodeSummary(opencodeRuntimeStatus, opencodeRuntimeLoading) : undefined}
          status={buildOpencodeRailStatus(opencodeRuntimeStatus, opencodeRuntimeLoading)}
        />
      </SettingsGroup>

      <SettingsGroup title="Aegis Built-in Agent">
        <div>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={aegisExpanded}
            onClick={openAegisEditor}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openAegisEditor();
              }
            }}
            className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--bg-secondary)]/60"
          >
            <span className="flex h-5 w-5 items-center justify-center">
              <Bot className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                  OpenAI-compatible runtime
                </span>
                {aegisNeedsKey ? (
                  <span className="text-[11px] text-[var(--text-muted)]">Needs key</span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--text-muted)]">
                {formatAegisBuiltInModel(aegisConfig.model)}
              </div>
            </div>
            <ChevronDown
              className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${aegisExpanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </div>

          {aegisExpanded && aegisDraft ? (
            <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveAegisConfig();
                }}
                className="space-y-4"
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <FormField label="Model" error={aegisErrors.model}>
                    <select
                      value={aegisDraft.model}
                      onChange={(event) => {
                        const selection = resolveAegisBuiltInModel(event.target.value);
                        const provider = getAegisBuiltInProvider(selection.providerId);
                        setAegisErrors((current) => ({ ...current, model: undefined }));
                        updateAegisDraft((current) => ({
                          ...current,
                          providerId: selection.providerId,
                          baseUrl: provider?.baseUrl || current.baseUrl,
                          model: selection.encoded,
                        }));
                      }}
                      className={getInputClassName(Boolean(aegisErrors.model))}
                      disabled={savingAegis}
                    >
                      {AEGIS_BUILT_IN_PROVIDERS.map((provider) => {
                        const models = listAegisBuiltInModels(provider.id);
                        if (models.length === 0) {
                          return null;
                        }
                        return (
                          <optgroup key={provider.id} label={provider.name}>
                            {models.map((model) => (
                              <option key={`${provider.id}:${model.id}`} value={`${provider.id}:${model.id}`}>
                                {model.name}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </FormField>

                  <FormField label="API key" error={aegisErrors.apiKey}>
                    <div className="relative">
                      <input
                        type={showAegisSecret ? 'text' : 'password'}
                        value={aegisDraft.apiKey}
                        onChange={(event) => {
                          setAegisErrors((current) => ({ ...current, apiKey: undefined }));
                          updateAegisDraft((current) => ({
                            ...current,
                            apiKey: event.target.value,
                          }));
                        }}
                        placeholder="Uses matching env key when empty"
                        className={getInputClassName(Boolean(aegisErrors.apiKey), true)}
                        disabled={savingAegis}
                      />
                      <button
                        type="button"
                        onClick={() => setShowAegisSecret((current) => !current)}
                        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                        aria-label={showAegisSecret ? 'Hide API key' : 'Show API key'}
                        disabled={savingAegis}
                      >
                        {showAegisSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </FormField>
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={openAegisEditor}
                    disabled={savingAegis}
                    className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingAegis}
                    className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    {savingAegis ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Claude-Compatible Providers">
        {PROVIDER_IDS.map((providerId) => {
          const provider = config.providers[providerId];
          const meta = PROVIDER_META[providerId];
          const expanded = expandedProviderId === providerId;
          const providerDraft = expanded ? draftProvider : null;
          const providerBusy = savingProvider === providerId;
          const configured = provider.baseUrl.trim() !== '' && provider.secret.trim() !== '';

          return (
            <ProviderRow
              key={providerId}
              label={meta.label}
              logo={<img src={meta.logo} alt="" className="h-5 w-5" aria-hidden="true" />}
              enabled={provider.enabled}
              configured={configured}
              expanded={expanded}
              disabled={loading || savingProvider !== null}
              onToggleEnabled={(next) => handleToggleEnabled(providerId, next)}
              onToggleExpand={() => openProviderEditor(providerId)}
            >
              {providerDraft ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveProvider();
                  }}
                  className="space-y-4"
                >
                  <FormField label="Base URL" error={errors.baseUrl}>
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
                  </FormField>

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <FormField label="Model" error={errors.model}>
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
                        hasError={Boolean(errors.model)}
                        disabled={providerBusy}
                      />
                    </FormField>

                    <FormField label="Token" error={errors.secret}>
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
                          placeholder="sk-..."
                          className={getInputClassName(Boolean(errors.secret), true)}
                          disabled={providerBusy}
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecret((current) => !current)}
                          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                          aria-label={showSecret ? 'Hide token' : 'Show token'}
                          disabled={providerBusy}
                        >
                          {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </FormField>
                  </div>

                  <div>
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen((current) => !current)}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                      aria-expanded={advancedOpen}
                    >
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-0' : '-rotate-90'}`} />
                      <span>Advanced</span>
                    </button>

                    {advancedOpen ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <FormField label="Small fast model">
                          <SuggestionInput
                            value={providerDraft.smallFastModel || ''}
                            onChange={(value) =>
                              updateDraftProvider((current) => ({
                                ...current,
                                smallFastModel: value,
                              }))
                            }
                            suggestions={smallFastModelSuggestions}
                            placeholder="Optional"
                            disabled={providerBusy}
                          />
                        </FormField>

                        <FormField label="Max output tokens">
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
                            placeholder="Optional"
                            className={getInputClassName(false)}
                            disabled={providerBusy}
                          />
                        </FormField>
                      </div>
                    ) : null}
                  </div>

                  {activeProviderMessage && activeProviderMessage.tone === 'error' ? (
                    <div className="rounded-md border border-[var(--error)]/25 bg-[var(--error)]/5 px-3 py-2 text-[12px] text-[var(--error)]">
                      {activeProviderMessage.text}
                    </div>
                  ) : null}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => openProviderEditor(providerId)}
                      disabled={providerBusy}
                      className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={providerBusy}
                      className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {providerBusy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              ) : null}
            </ProviderRow>
          );
        })}
      </SettingsGroup>
    </div>
  );
}

function RuntimeStatusRow({
  title,
  logo,
  detail,
  status,
}: {
  title: string;
  logo: ReactNode;
  detail?: string;
  status: { label: string; tone: string; dot: string };
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5">
      <span className="flex h-5 w-5 items-center justify-center">{logo}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
        {detail ? (
          <div className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--text-muted)]">{detail}</div>
        ) : null}
      </div>
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
        <span className={status.tone}>{status.label}</span>
      </span>
    </div>
  );
}

function ProviderRow({
  label,
  logo,
  enabled,
  configured,
  expanded,
  disabled,
  onToggleEnabled,
  onToggleExpand,
  children,
}: {
  label: string;
  logo: ReactNode;
  enabled: boolean;
  configured: boolean;
  expanded: boolean;
  disabled?: boolean;
  onToggleEnabled: (next: boolean) => void;
  onToggleExpand: () => void;
  children?: ReactNode;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggleExpand();
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggleExpand}
        onKeyDown={handleKeyDown}
        className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--bg-secondary)]/60"
      >
        <span className="flex h-5 w-5 items-center justify-center">{logo}</span>
        <div className="min-w-0 flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">{label}</span>
          {enabled && !configured ? (
            <span className="text-[11px] text-[var(--text-muted)]">Needs setup</span>
          ) : null}
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <SettingsToggle
            checked={enabled}
            onChange={onToggleEnabled}
            disabled={disabled}
            ariaLabel={enabled ? `Disable ${label}` : `Enable ${label}`}
          />
          <ChevronDown
            className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </div>
      </div>

      {expanded && children ? (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-[var(--text-muted)]">{label}</div>
      {children}
      {error ? <div className="mt-1 text-[11.5px] text-[var(--error)]">{error}</div> : null}
    </div>
  );
}

function SuggestionInput({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
  hasError,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
}) {
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={getInputClassName(Boolean(hasError), true)}
        disabled={disabled}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            disabled={disabled}
            aria-label="Open model suggestions"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[280px]">
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
  return `h-8 w-full rounded-md border bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] ${
    withTrailingControl ? 'pr-8' : ''
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
