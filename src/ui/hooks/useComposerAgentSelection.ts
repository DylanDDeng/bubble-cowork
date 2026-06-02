import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProvider, ClaudeCompatibleProviderId, SettingsTab } from '../types';
import { useClaudeModelConfig } from './useClaudeModelConfig';
import { useCodexModelConfig } from './useCodexModelConfig';
import { useOpencodeModelConfig } from './useOpencodeModelConfig';
import { useCompatibleProviderConfig } from './useCompatibleProviderConfig';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import {
  canonicalizeClaudeModel,
  buildClaudeModelOptions,
  formatClaudeModelLabel,
  isOfficialClaudeModel,
  loadPreferredClaudeCompatibleProviderId,
  loadPreferredClaudeModel,
  savePreferredClaudeCompatibleProviderId,
  savePreferredClaudeModel,
} from '../utils/claude-model';
import {
  buildCodexModelOptions,
  formatCodexModelLabel,
  loadPreferredCodexModel,
  resolveCodexModel,
  savePreferredCodexModel,
} from '../utils/codex-model';
import {
  CodexReasoningEffort,
} from '../../shared/types';
import {
  getDefaultCodexReasoningEffort,
  loadPreferredCodexReasoningEffort,
  savePreferredCodexReasoningEffort,
} from '../utils/codex-reasoning';
import {
  loadPreferredCodexFastMode,
  savePreferredCodexFastMode,
  supportsCodexFastMode,
} from '../utils/codex-fast';
import {
  buildOpencodeModelOptions,
  formatOpencodeModelLabel,
  loadPreferredOpencodeModel,
  savePreferredOpencodeModel,
} from '../utils/opencode-model';
import {
  AEGIS_BUILT_IN_MODELS,
  AEGIS_BUILT_IN_PROVIDERS,
  getAegisBuiltInModel,
  getAegisBuiltInProvider,
  resolveAegisBuiltInModel,
} from '../../shared/aegis-built-in-catalog';
import type { AegisBuiltInAgentConfig } from '../../shared/types';

const AEGIS_MODEL_STORAGE_KEY = 'cowork.preferredAegisModel';

export interface ComposerModelOption {
  key: string;
  value: string;
  label: string;
  description?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId | null;
}

export interface ComposerModelSetupState {
  label: string;
  title: string;
  settingsTab: SettingsTab;
}

function loadPreferredAegisModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(AEGIS_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredAegisModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(AEGIS_MODEL_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AEGIS_MODEL_STORAGE_KEY, model);
}

function resolveCompatibleProviderForModel(
  model: string | null | undefined,
  preferredProviderId: ClaudeCompatibleProviderId | null | undefined,
  compatibleOptions: Array<{ id: ClaudeCompatibleProviderId; model: string }>
): ClaudeCompatibleProviderId | null {
  const normalized = model?.trim();
  if (!normalized) return null;
  const matches = compatibleOptions.filter((option) => option.model === normalized);
  if (matches.length === 0) return null;
  if (preferredProviderId && matches.some((option) => option.id === preferredProviderId)) {
    return preferredProviderId;
  }
  return matches[0]?.id || null;
}

function formatAegisModelLabel(value: string): string {
  const selection = resolveAegisBuiltInModel(value);
  const provider = getAegisBuiltInProvider(selection.providerId);
  const model = getAegisBuiltInModel(selection.providerId, selection.modelId);
  return model?.name || `${provider?.name || selection.providerId} · ${selection.modelId}`;
}

function buildConfiguredClaudeModelValues(
  config: { defaultModel: string | null; options: string[] },
  compatibleOptions: Array<{ model: string }>
): string[] {
  const compatibleModels = new Set(compatibleOptions.map((option) => option.model.trim()).filter(Boolean));
  const defaultModel = canonicalizeClaudeModel(config.defaultModel);
  return Array.from(
    new Set(
      buildClaudeModelOptions(config)
        .map((value) => canonicalizeClaudeModel(value))
        .filter((value): value is string => Boolean(value))
        .filter((value) => isOfficialClaudeModel(value))
        .filter((value) => value === defaultModel || !compatibleModels.has(value))
    )
  );
}

function resolveConfiguredClaudeSelection(
  requestedModel: string | null,
  requestedCompatibleProviderId: ClaudeCompatibleProviderId | null | undefined,
  config: { defaultModel: string | null; options: string[] },
  compatibleOptions: Array<{ id: ClaudeCompatibleProviderId; model: string }>
): { model: string | null; compatibleProviderId: ClaudeCompatibleProviderId | null } {
  const officialOptions = buildConfiguredClaudeModelValues(config, compatibleOptions);
  const selectCandidate = (
    candidateModel: string | null | undefined,
    candidateCompatibleProviderId?: ClaudeCompatibleProviderId | null
  ): { model: string; compatibleProviderId: ClaudeCompatibleProviderId | null } | null => {
    const normalized = canonicalizeClaudeModel(candidateModel);
    if (!normalized) return null;

    if (candidateCompatibleProviderId) {
      const compatibleMatch = compatibleOptions.find(
        (option) => option.id === candidateCompatibleProviderId && option.model === normalized
      );
      if (compatibleMatch) {
        return { model: compatibleMatch.model, compatibleProviderId: compatibleMatch.id };
      }
    }

    if (officialOptions.includes(normalized)) {
      return { model: normalized, compatibleProviderId: null };
    }

    const compatibleProviderId = resolveCompatibleProviderForModel(
      normalized,
      candidateCompatibleProviderId,
      compatibleOptions
    );
    if (compatibleProviderId) {
      return { model: normalized, compatibleProviderId };
    }

    return null;
  };

  return (
    selectCandidate(requestedModel, requestedCompatibleProviderId) ||
    selectCandidate(loadPreferredClaudeModel(), loadPreferredClaudeCompatibleProviderId()) ||
    selectCandidate(config.defaultModel, null) ||
    { model: null, compatibleProviderId: null }
  );
}

function getAegisProviderApiKey(config: AegisBuiltInAgentConfig, providerId: string): string {
  return config.providerApiKeys?.[providerId] || (config.providerId === providerId ? config.apiKey : '');
}

function getConfiguredAegisProviderIds(config: AegisBuiltInAgentConfig | null): Set<string> {
  if (!config) {
    return new Set();
  }

  return new Set(
    AEGIS_BUILT_IN_PROVIDERS
      .map((provider) => provider.id)
      .filter((providerId) => getAegisProviderApiKey(config, providerId).trim().length > 0)
  );
}

function buildConfiguredAegisModelOptions(config: AegisBuiltInAgentConfig | null): ComposerModelOption[] {
  const configuredProviderIds = getConfiguredAegisProviderIds(config);
  if (configuredProviderIds.size === 0) {
    return [];
  }

  return AEGIS_BUILT_IN_MODELS.filter((model) => configuredProviderIds.has(model.providerId)).map((model) => {
    const provider = getAegisBuiltInProvider(model.providerId);
    const encoded = `${model.providerId}:${model.id}`;
    return {
      key: `aegis:${encoded}`,
      value: encoded,
      label: model.name,
      description: provider?.name || model.providerId,
    };
  });
}

function resolveConfiguredAegisModel(
  requestedModel: string | null | undefined,
  config: AegisBuiltInAgentConfig | null
): string | null {
  const options = buildConfiguredAegisModelOptions(config);
  if (options.length === 0) {
    return null;
  }

  const optionValues = new Set(options.map((option) => option.value));
  const candidates = [
    requestedModel,
    loadPreferredAegisModel(),
    config ? resolveAegisBuiltInModel(config.model, config.providerId).encoded : null,
  ];

  for (const candidate of candidates) {
    const normalized = candidate ? resolveAegisBuiltInModel(candidate).encoded : null;
    if (normalized && optionValues.has(normalized)) {
      return normalized;
    }
  }

  return options[0]?.value || null;
}

export function useComposerAgentSelection(input?: {
  selectionKey?: string | null;
  provider?: AgentProvider | null;
  model?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId | null;
}) {
  const claudeModelConfig = useClaudeModelConfig();
  const codexModelConfig = useCodexModelConfig();
  const opencodeModelConfig = useOpencodeModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const [aegisConfig, setAegisConfig] = useState<AegisBuiltInAgentConfig | null>(null);
  const [provider, setProviderState] = useState<AgentProvider>(() => input?.provider || loadPreferredProvider());
  const [model, setModelState] = useState<string | null>(() => input?.model?.trim() || null);
  const [compatibleProviderId, setCompatibleProviderId] = useState<ClaudeCompatibleProviderId | null>(
    () => input?.compatibleProviderId || null
  );
  const lastSelectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refreshAegisConfig = () => {
      window.electron
        .getAegisBuiltInAgentConfig()
        .then((config) => {
          if (!cancelled) {
            setAegisConfig(config);
          }
        })
        .catch((error) => {
          console.error('Failed to load Aegis model config:', error);
        });
    };

    refreshAegisConfig();
    window.addEventListener('aegis-built-in-agent-config-updated', refreshAegisConfig);

    return () => {
      cancelled = true;
      window.removeEventListener('aegis-built-in-agent-config-updated', refreshAegisConfig);
    };
  }, []);

  const modelOptions = useMemo<ComposerModelOption[]>(() => {
    if (provider === 'claude') {
      const defaultOption: ComposerModelOption = {
        key: 'claude:official:default',
        value: '',
        label: 'Default',
        description: 'Do not override the default model',
        compatibleProviderId: null,
      };
      const officialOptions = buildConfiguredClaudeModelValues(claudeModelConfig, compatibleOptions).map((option) => ({
        key: `claude:official:${option}`,
        value: option,
        label: formatClaudeModelLabel(option),
        compatibleProviderId: null,
      }));
      const compatible = compatibleOptions.map((option) => ({
        key: `claude:compatible:${option.id}:${option.model}`,
        value: option.model,
        label: option.model,
        description: option.label,
        compatibleProviderId: option.id,
      }));
      return [defaultOption, ...officialOptions, ...compatible];
    }

    if (provider === 'codex') {
      return buildCodexModelOptions(codexModelConfig).map((option) => ({
        key: `codex:${option}`,
        value: option,
        label: formatCodexModelLabel(option),
      }));
    }

    if (provider === 'opencode') {
      return buildOpencodeModelOptions(opencodeModelConfig).map((option) => ({
        key: `opencode:${option}`,
        value: option,
        label: formatOpencodeModelLabel(option),
      }));
    }

    return buildConfiguredAegisModelOptions(aegisConfig);
  }, [aegisConfig, claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, provider]);

  const resolveModelForProvider = useCallback(
    (
      nextProvider: AgentProvider,
      requestedModel?: string | null,
      requestedCompatibleProviderId?: ClaudeCompatibleProviderId | null
    ): { model: string | null; compatibleProviderId: ClaudeCompatibleProviderId | null } => {
      const normalizedRequestedModel = requestedModel?.trim() || null;
      if (nextProvider === 'claude') {
        return resolveConfiguredClaudeSelection(
          normalizedRequestedModel,
          requestedCompatibleProviderId,
          claudeModelConfig,
          compatibleOptions
        );
      }

      if (nextProvider === 'codex') {
        return {
          model: resolveCodexModel(normalizedRequestedModel || loadPreferredCodexModel(), codexModelConfig),
          compatibleProviderId: null,
        };
      }

      if (nextProvider === 'opencode') {
        const options = buildOpencodeModelOptions(opencodeModelConfig);
        const preferredModel = loadPreferredOpencodeModel();
        const nextModel =
          normalizedRequestedModel ||
          preferredModel ||
          opencodeModelConfig.defaultModel ||
          options[0] ||
          null;
        return {
          model: nextModel && (options.length === 0 || options.includes(nextModel)) ? nextModel : options[0] || null,
          compatibleProviderId: null,
        };
      }

      return {
        model: resolveConfiguredAegisModel(normalizedRequestedModel, aegisConfig),
        compatibleProviderId: null,
      };
    },
    [aegisConfig, claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig]
  );

  useEffect(() => {
    const selectionKey = input?.selectionKey ?? '__default__';
    if (lastSelectionKeyRef.current === selectionKey) {
      return;
    }
    lastSelectionKeyRef.current = selectionKey;
    const nextProvider = input?.provider || loadPreferredProvider();
    const nextSelection = resolveModelForProvider(
      nextProvider,
      input?.model,
      input?.compatibleProviderId
    );
    setProviderState(nextProvider);
    setModelState(nextSelection.model);
    setCompatibleProviderId(nextSelection.compatibleProviderId);
  }, [
    input?.compatibleProviderId,
    input?.model,
    input?.provider,
    input?.selectionKey,
    resolveModelForProvider,
  ]);

  useEffect(() => {
    if (model) {
      return;
    }
    const nextSelection = resolveModelForProvider(provider);
    setModelState(nextSelection.model);
    setCompatibleProviderId(nextSelection.compatibleProviderId);
  }, [model, provider, resolveModelForProvider]);

  useEffect(() => {
    const normalizedModel = model?.trim() || null;
    const selectedModelStillConfigured = modelOptions.some(
      (option) =>
        (option.value.trim() || null) === normalizedModel &&
        (option.compatibleProviderId || null) === (compatibleProviderId || null)
    );
    if (selectedModelStillConfigured || (!model && modelOptions.length === 0)) {
      return;
    }

    const nextSelection = resolveModelForProvider(provider);
    if (
      nextSelection.model !== model ||
      nextSelection.compatibleProviderId !== (compatibleProviderId || null)
    ) {
      setModelState(nextSelection.model);
      setCompatibleProviderId(nextSelection.compatibleProviderId);
    }
  }, [compatibleProviderId, model, modelOptions, provider, resolveModelForProvider]);

  const selectAgent = useCallback(
    (nextProvider: AgentProvider) => {
      savePreferredProvider(nextProvider);
      const nextSelection = resolveModelForProvider(nextProvider);
      setProviderState(nextProvider);
      setModelState(nextSelection.model);
      setCompatibleProviderId(nextSelection.compatibleProviderId);
    },
    [resolveModelForProvider]
  );

  const selectModel = useCallback(
    (option: ComposerModelOption) => {
      const nextModel = option.value.trim() || null;
      const nextCompatibleProviderId = option.compatibleProviderId || null;
      setModelState(nextModel);
      setCompatibleProviderId(nextCompatibleProviderId);

      if (provider === 'claude') {
        savePreferredClaudeModel(nextModel);
        savePreferredClaudeCompatibleProviderId(nextCompatibleProviderId);
      } else if (provider === 'codex') {
        savePreferredCodexModel(nextModel);
      } else if (provider === 'opencode') {
        savePreferredOpencodeModel(nextModel);
      } else {
        savePreferredAegisModel(nextModel);
      }
    },
    [provider]
  );

  const selectedModelOption = useMemo(() => {
    const normalizedModel = model?.trim() || null;
    return (
      modelOptions.find(
        (option) =>
          (option.value.trim() || null) === normalizedModel &&
          (option.compatibleProviderId || null) === (compatibleProviderId || null)
      ) ||
      modelOptions.find((option) => (option.value.trim() || null) === normalizedModel) ||
      null
    );
  }, [compatibleProviderId, model, modelOptions]);

  const modelSetup = useMemo<ComposerModelSetupState | null>(() => {
    if (modelOptions.length > 0) {
      return null;
    }

    if (provider === 'claude') {
      return null;
    }

    if (provider === 'aegis') {
      return {
        label: 'Configure Aegis',
        title: 'Configure Aegis model',
        settingsTab: 'aegis',
      };
    }

    if (provider === 'codex') {
      return {
        label: 'Setup Codex',
        title: 'Configure Codex CLI models',
        settingsTab: 'providers',
      };
    }

    return {
      label: 'Setup OpenCode',
      title: 'Configure OpenCode models',
      settingsTab: 'providers',
    };
  }, [modelOptions.length, provider]);

  const selectedModelLabel =
    modelSetup?.label ||
    selectedModelOption?.label ||
    (model
      ? provider === 'aegis'
        ? formatAegisModelLabel(model)
        : model
      : 'Default');

  const [codexReasoningEffort, setCodexReasoningEffortState] = useState<CodexReasoningEffort | null>(() => {
    if (provider !== 'codex' || !model) return null;
    const preferred = loadPreferredCodexReasoningEffort(model);
    if (preferred) return preferred;
    return getDefaultCodexReasoningEffort(codexModelConfig, model) || null;
  });

  // Sync reasoning effort when model changes
  useEffect(() => {
    if (provider === 'codex' && model) {
      const preferred = loadPreferredCodexReasoningEffort(model);
      if (preferred) {
        setCodexReasoningEffortState(preferred);
      } else {
        const defaultEffort = getDefaultCodexReasoningEffort(codexModelConfig, model);
        setCodexReasoningEffortState(defaultEffort || null);
      }
    } else {
      setCodexReasoningEffortState(null);
    }
  }, [provider, model, codexModelConfig]);

  const setCodexReasoningEffort = useCallback(
    (effort: CodexReasoningEffort) => {
      setCodexReasoningEffortState(effort);
      if (model) {
        savePreferredCodexReasoningEffort(model, effort);
      }
    },
    [model]
  );

  const codexModels = useMemo(() => {
    if (provider !== 'codex' || !codexModelConfig) return [];
    return codexModelConfig.availableModels;
  }, [provider, codexModelConfig]);

  // Fast mode state
  const supportsCodexFastModeCheck = useMemo(
    () => provider === 'codex' && supportsCodexFastMode(codexModelConfig, model ?? undefined),
    [provider, codexModelConfig, model]
  );

  const [codexFastMode, setCodexFastModeState] = useState<boolean>(() => {
    if (!supportsCodexFastModeCheck || !model) return false;
    return loadPreferredCodexFastMode(codexModelConfig, model) === true;
  });

  // Sync fast mode when model changes
  useEffect(() => {
    if (supportsCodexFastModeCheck && model) {
      const preferred = loadPreferredCodexFastMode(codexModelConfig, model);
      setCodexFastModeState(preferred === true);
    } else {
      setCodexFastModeState(false);
    }
  }, [supportsCodexFastModeCheck, codexModelConfig, model]);

  const setCodexFastMode = useCallback(
    (enabled: boolean) => {
      setCodexFastModeState(enabled);
      if (model) {
        savePreferredCodexFastMode(codexModelConfig, model, enabled);
      }
    },
    [codexModelConfig, model]
  );

  return {
    provider,
    model,
    compatibleProviderId,
    modelOptions,
    modelSetup,
    selectedModelOption,
    selectedModelLabel,
    selectAgent,
    selectModel,
    codexModelConfig,
    codexModels,
    codexReasoningEffort,
    setCodexReasoningEffort,
    codexFastMode,
    setCodexFastMode,
  };
}
