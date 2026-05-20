import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff } from '../icons';
import type { AegisBuiltInAgentConfig } from '../../types';
import {
  AEGIS_BUILT_IN_DEFAULT_MODEL,
  AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  AEGIS_BUILT_IN_PROVIDERS,
  encodeAegisBuiltInModel,
  getAegisBuiltInProvider,
  listAegisBuiltInModels,
  resolveAegisBuiltInModel,
} from '../../../shared/aegis-built-in-catalog';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import aegisAvatar from '../../assets/agent-avatars/anime-avatar-03.png';

const DEFAULT_PROVIDER = getAegisBuiltInProvider(AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID);
const DEFAULT_CONFIG: AegisBuiltInAgentConfig = {
  providerId: AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  baseUrl: DEFAULT_PROVIDER?.baseUrl || 'https://api.openai.com/v1',
  apiKey: '',
  providerApiKeys: {},
  model: AEGIS_BUILT_IN_DEFAULT_MODEL,
  temperature: 0.2,
};

const FIELD_CONTROL_CLASS =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)] disabled:opacity-60';

function normalizeConfig(raw: unknown): AegisBuiltInAgentConfig {
  const input = raw && typeof raw === 'object' ? raw as Partial<AegisBuiltInAgentConfig> : {};
  const selection = resolveAegisBuiltInModel(input.model, input.providerId);
  const provider = getAegisBuiltInProvider(selection.providerId) || DEFAULT_PROVIDER;
  const providerApiKeys = normalizeProviderApiKeys(input.providerApiKeys);
  const legacyApiKey = input.apiKey?.trim() || '';
  if (legacyApiKey && !providerApiKeys[selection.providerId]) {
    providerApiKeys[selection.providerId] = legacyApiKey;
  }
  const maxOutputTokens =
    typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)
      ? Math.max(1, Math.trunc(input.maxOutputTokens))
      : undefined;
  return {
    providerId: selection.providerId,
    baseUrl: provider?.baseUrl || input.baseUrl?.trim() || DEFAULT_CONFIG.baseUrl,
    apiKey: providerApiKeys[selection.providerId] || '',
    providerApiKeys,
    model: selection.encoded,
    temperature:
      typeof input.temperature === 'number' && Number.isFinite(input.temperature)
        ? Math.max(0, Math.min(2, input.temperature))
        : DEFAULT_CONFIG.temperature,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

function normalizeProviderApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([providerId, apiKey]) => [providerId.trim(), typeof apiKey === 'string' ? apiKey.trim() : ''] as const)
      .filter(([providerId, apiKey]) => providerId && apiKey)
  );
}

function getProviderApiKey(config: AegisBuiltInAgentConfig, providerId: string): string {
  return config.providerApiKeys?.[providerId] || (config.providerId === providerId ? config.apiKey : '');
}

function setProviderApiKey(
  config: AegisBuiltInAgentConfig,
  providerId: string,
  apiKey: string
): AegisBuiltInAgentConfig {
  const providerApiKeys = { ...(config.providerApiKeys || {}) };
  const normalized = apiKey.trim();
  if (normalized) {
    providerApiKeys[providerId] = normalized;
  } else {
    delete providerApiKeys[providerId];
  }

  return {
    ...config,
    apiKey,
    providerApiKeys,
  };
}

export function AegisBuiltInSettingsContent() {
  const [savedConfig, setSavedConfig] = useState<AegisBuiltInAgentConfig>(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState<AegisBuiltInAgentConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getAegisBuiltInAgentConfig()
      .then((config) => {
        if (cancelled) return;
        const normalized = normalizeConfig(config);
        setSavedConfig(normalized);
        setDraftConfig(normalized);
      })
      .catch((error) => {
        console.error('Failed to load Aegis config:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to load Aegis config.');
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

  const selection = resolveAegisBuiltInModel(draftConfig.model, draftConfig.providerId);
  const provider = getAegisBuiltInProvider(selection.providerId) || DEFAULT_PROVIDER;
  const providerModels = useMemo(
    () => listAegisBuiltInModels(selection.providerId),
    [selection.providerId]
  );
  const currentApiKey = getProviderApiKey(draftConfig, selection.providerId);
  const hasApiKey = currentApiKey.trim().length > 0;
  const dirty = JSON.stringify(normalizeConfig(savedConfig)) !== JSON.stringify(normalizeConfig(draftConfig));

  const handleProviderChange = (providerId: string) => {
    const nextProvider = getAegisBuiltInProvider(providerId);
    const nextModels = listAegisBuiltInModels(providerId);
    const currentModelId = resolveAegisBuiltInModel(draftConfig.model, draftConfig.providerId).modelId;
    const nextModel = nextModels.find((model) => model.id === currentModelId) || nextModels[0];
    const nextModelId = nextModel?.id || currentModelId;

    setDraftConfig((current) => ({
      ...current,
      providerId,
      baseUrl: nextProvider?.baseUrl || current.baseUrl,
      model: encodeAegisBuiltInModel(providerId, nextModelId),
      apiKey: getProviderApiKey(current, providerId),
    }));
  };

  const handleModelChange = (model: string) => {
    const nextSelection = resolveAegisBuiltInModel(model, draftConfig.providerId);
    const nextProvider = getAegisBuiltInProvider(nextSelection.providerId);
    setDraftConfig((current) => ({
      ...current,
      providerId: nextSelection.providerId,
      baseUrl: nextProvider?.baseUrl || current.baseUrl,
      model: nextSelection.encoded,
      apiKey: getProviderApiKey(current, nextSelection.providerId),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const normalized = normalizeConfig(draftConfig);
      const saved = normalizeConfig(await window.electron.saveAegisBuiltInAgentConfig(normalized));
      setSavedConfig(saved);
      setDraftConfig(saved);
      window.dispatchEvent(new CustomEvent('aegis-built-in-agent-config-updated'));
      toast.success('Aegis settings saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Aegis settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup title="Runtime">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-secondary)]">
            <img src={aegisAvatar} alt="" className="h-full w-full object-cover" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">Aegis</div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--text-muted)]">
              {provider?.name || selection.providerId} · {selection.modelId}
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <span className={`h-1.5 w-1.5 rounded-full ${hasApiKey ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className={hasApiKey ? 'text-emerald-700' : 'text-amber-700'}>
              {hasApiKey ? 'Configured' : 'Needs key'}
            </span>
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Model"
        description="This only configures Aegis. Claude Code, Codex, and OpenCode keep their own native settings."
      >
        <SettingsRow
          variant="card"
          label="Provider"
          description="Choose the OpenAI-compatible backend used by the Aegis runtime."
        >
          <select
            value={selection.providerId}
            onChange={(event) => handleProviderChange(event.target.value)}
            className={FIELD_CONTROL_CLASS}
            disabled={loading || saving}
          >
            {AEGIS_BUILT_IN_PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Model"
          description="This is the default model shown when you select Aegis in Composer."
        >
          <select
            value={selection.encoded}
            onChange={(event) => handleModelChange(event.target.value)}
            className={FIELD_CONTROL_CLASS}
            disabled={loading || saving || providerModels.length === 0}
          >
            {providerModels.map((model) => (
              <option key={`${model.providerId}:${model.id}`} value={encodeAegisBuiltInModel(model.providerId, model.id)}>
                {model.name}
              </option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Base URL"
          description="Derived from the selected provider catalog."
        >
          <input
            value={provider?.baseUrl || draftConfig.baseUrl}
            readOnly
            className={FIELD_CONTROL_CLASS}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Credentials">
        <SettingsRow
          variant="card"
          label="API key"
          description={`Saved for ${provider?.name || selection.providerId}. You can also provide the matching environment key outside Aegis.`}
        >
          <div className="flex min-w-[260px] gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={currentApiKey}
                onChange={(event) =>
                  setDraftConfig((current) => setProviderApiKey(current, selection.providerId, event.target.value))
                }
                placeholder="Provider API key"
                className={`${FIELD_CONTROL_CLASS} pr-8`}
                disabled={loading || saving}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((current) => !current)}
                className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                disabled={loading || saving}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Generation">
        <SettingsRow
          variant="card"
          label="Temperature"
          description="Lower values make answers more deterministic."
        >
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={draftConfig.temperature}
            onChange={(event) =>
              setDraftConfig((current) => ({
                ...current,
                temperature: Math.max(0, Math.min(2, Number(event.target.value) || 0)),
              }))
            }
            className={FIELD_CONTROL_CLASS}
            disabled={loading || saving}
          />
        </SettingsRow>

        <SettingsRow
          variant="card"
          label="Max output tokens"
          description="Optional cap for built-in responses."
        >
          <input
            type="number"
            min="1"
            step="1"
            value={draftConfig.maxOutputTokens ?? ''}
            onChange={(event) =>
              setDraftConfig((current) => ({
                ...current,
                maxOutputTokens: event.target.value
                  ? Math.max(1, Math.trunc(Number(event.target.value)))
                  : undefined,
              }))
            }
            placeholder="Default"
            className={FIELD_CONTROL_CLASS}
            disabled={loading || saving}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={loading || saving || !dirty}
          className="inline-flex h-8 items-center rounded-md bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
