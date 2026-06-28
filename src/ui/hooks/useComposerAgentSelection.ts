import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProvider, ClaudeCompatibleProviderId, SettingsTab } from '../types';
import { useClaudeModelConfig } from './useClaudeModelConfig';
import { useCodexModelConfig } from './useCodexModelConfig';
import { useOpencodeModelConfig } from './useOpencodeModelConfig';
import { useKimiModelConfig } from './useKimiModelConfig';
import { useGrokModelConfig } from './useGrokModelConfig';
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
  ClaudeAccessMode,
  ClaudePermissionMode,
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  CodexPermissionMode,
  KimiPermissionMode,
  OpenCodePermissionMode,
} from '../../shared/types';
import {
  getDefaultCodexReasoningEffort,
  loadPreferredCodexReasoningEffort,
  savePreferredCodexReasoningEffort,
} from '../utils/codex-reasoning';
import {
  getDefaultClaudeReasoningEffort,
  loadPreferredClaudeReasoningEffort,
  savePreferredClaudeReasoningEffort,
} from '../utils/claude-reasoning';
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
  loadPreferredClaudePermissionMode,
  normalizeClaudePermissionMode,
  savePreferredClaudePermissionMode,
} from '../utils/claude-permission';
import {
  loadPreferredKimiPermissionMode,
  savePreferredKimiPermissionMode,
} from '../utils/kimi-permission';
import {
  loadPreferredOpencodePermissionMode,
  savePreferredOpencodePermissionMode,
} from '../utils/opencode-permission';
const KIMI_MODEL_STORAGE_KEY = 'cowork.preferredKimiModel';
const GROK_MODEL_STORAGE_KEY = 'cowork.preferredGrokModel';

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

function loadPreferredKimiModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(KIMI_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredKimiModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(KIMI_MODEL_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(KIMI_MODEL_STORAGE_KEY, model);
}

function loadPreferredGrokModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(GROK_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredGrokModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(GROK_MODEL_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(GROK_MODEL_STORAGE_KEY, model);
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

function buildKimiModelOptions(config: ReturnType<typeof useKimiModelConfig>): ComposerModelOption[] {
  const defaultOption: ComposerModelOption = {
    key: 'kimi:default',
    value: '',
    label: 'Default',
    description: config.defaultModel ? `Use ${formatKimiModelLabel(config.defaultModel, config)}` : 'Use Kimi Code default model',
  };
  const models = config.availableModels.length > 0
    ? config.availableModels
    : config.options.map((name) => ({ name, label: name, provider: null, enabled: true, isDefault: config.defaultModel === name }));
  const explicitOptions = models
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      key: `kimi:${model.name}`,
      value: model.name,
      label: model.label || model.name,
      description: model.isDefault
        ? 'Configured default'
        : model.provider
          ? model.provider
          : undefined,
    }));
  return [defaultOption, ...explicitOptions];
}

function formatKimiModelLabel(value: string, config: ReturnType<typeof useKimiModelConfig>): string {
  const match = config.availableModels.find((model) => model.name === value);
  return match?.label || value;
}

function resolveConfiguredKimiModel(
  requestedModel: string | null | undefined,
  config: ReturnType<typeof useKimiModelConfig>
): string | null {
  const options = buildKimiModelOptions(config);
  const optionValues = new Set(options.map((option) => option.value.trim()));
  const candidates = [requestedModel, loadPreferredKimiModel()];
  for (const candidate of candidates) {
    const normalized = candidate?.trim() || null;
    if (normalized && optionValues.has(normalized)) {
      return normalized;
    }
  }
  return null;
}

function buildGrokModelOptions(config: ReturnType<typeof useGrokModelConfig>): ComposerModelOption[] {
  const defaultOption: ComposerModelOption = {
    key: 'grok:default',
    value: '',
    label: 'Default',
    description: config.defaultModel ? `Use ${formatGrokModelLabel(config.defaultModel, config)}` : 'Use Grok Build default model',
  };
  const models = config.availableModels.length > 0
    ? config.availableModels
    : config.options.map((name) => ({ name, label: name, provider: null, enabled: true, isDefault: config.defaultModel === name }));
  const explicitOptions = models
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      key: `grok:${model.name}`,
      value: model.name,
      label: model.label || model.name,
      description: model.isDefault
        ? 'Configured default'
        : model.provider
          ? model.provider
          : undefined,
    }));
  return [defaultOption, ...explicitOptions];
}

function formatGrokModelLabel(value: string, config: ReturnType<typeof useGrokModelConfig>): string {
  const match = config.availableModels.find((model) => model.name === value);
  return match?.label || value;
}

function resolveConfiguredGrokModel(
  requestedModel: string | null | undefined,
  config: ReturnType<typeof useGrokModelConfig>
): string | null {
  const options = buildGrokModelOptions(config);
  const optionValues = new Set(options.map((option) => option.value.trim()));
  const candidates = [requestedModel, loadPreferredGrokModel()];
  for (const candidate of candidates) {
    const normalized = candidate?.trim() || null;
    if (normalized && optionValues.has(normalized)) {
      return normalized;
    }
  }
  return null;
}

function buildOpencodeComposerModelOptions(config: ReturnType<typeof useOpencodeModelConfig>): ComposerModelOption[] {
  const defaultOption: ComposerModelOption = {
    key: 'opencode:default',
    value: '',
    label: 'Default',
    description: config.defaultModel ? `Use ${formatOpencodeModelLabel(config.defaultModel)}` : 'Use OpenCode default model',
  };
  const explicitOptions = buildOpencodeModelOptions(config).map((option) => ({
    key: `opencode:${option}`,
    value: option,
    label: formatOpencodeModelLabel(option),
  }));
  return [defaultOption, ...explicitOptions];
}

export function useComposerAgentSelection(input?: {
  selectionKey?: string | null;
  provider?: AgentProvider | null;
  model?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId | null;
  // Accepts the wider access mode (includes 'fullAccess'); normalized internally.
  claudePermissionMode?: ClaudeAccessMode | null;
  opencodePermissionMode?: OpenCodePermissionMode | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
}) {
  const claudeModelConfig = useClaudeModelConfig();
  const codexModelConfig = useCodexModelConfig();
  const opencodeModelConfig = useOpencodeModelConfig();
  const kimiModelConfig = useKimiModelConfig();
  const grokModelConfig = useGrokModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const [provider, setProviderState] = useState<AgentProvider>(() => input?.provider || loadPreferredProvider());
  const [model, setModelState] = useState<string | null>(() => input?.model?.trim() || null);
  const [compatibleProviderId, setCompatibleProviderId] = useState<ClaudeCompatibleProviderId | null>(
    () => input?.compatibleProviderId || null
  );
  const lastSelectionKeyRef = useRef<string | null>(null);

  const allAgentModelOptions = useMemo(() => {
    return {
      claude: (() => {
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
      })(),
      codex: buildCodexModelOptions(codexModelConfig).map((option) => ({
        key: `codex:${option}`,
        value: option,
        label: formatCodexModelLabel(option),
      })),
      opencode: buildOpencodeComposerModelOptions(opencodeModelConfig),
      kimi: buildKimiModelOptions(kimiModelConfig),
      grok: buildGrokModelOptions(grokModelConfig),
    };
  }, [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig]);

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
      return buildOpencodeComposerModelOptions(opencodeModelConfig);
    }

    if (provider === 'kimi') {
      return buildKimiModelOptions(kimiModelConfig);
    }

    if (provider === 'grok') {
      return buildGrokModelOptions(grokModelConfig);
    }

    return [];
  }, [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig, provider]);

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

      if (nextProvider === 'kimi') {
        return {
          model: resolveConfiguredKimiModel(normalizedRequestedModel, kimiModelConfig),
          compatibleProviderId: null,
        };
      }

      if (nextProvider === 'grok') {
        return {
          model: resolveConfiguredGrokModel(normalizedRequestedModel, grokModelConfig),
          compatibleProviderId: null,
        };
      }

      return {
        model: null,
        compatibleProviderId: null,
      };
    },
    [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig]
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
    input?.claudePermissionMode,
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
      } else if (provider === 'kimi') {
        savePreferredKimiModel(nextModel);
      } else if (provider === 'grok') {
        savePreferredGrokModel(nextModel);
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

    if (provider === 'kimi') {
      return {
        label: 'Setup Kimi',
        title: 'Configure Kimi Code models',
        settingsTab: 'providers',
      };
    }

    if (provider === 'grok') {
      return {
        label: 'Setup Grok',
        title: 'Configure Grok Build',
        settingsTab: 'providers',
      };
    }

    if (provider === 'codex') {
      return {
        label: 'Setup Codex',
        title: 'Configure Codex CLI models',
        settingsTab: 'providers',
      };
    }

    if (provider === 'opencode') {
      return null;
    }

    return null;
  }, [modelOptions.length, provider]);

  const selectedModelLabel =
    modelSetup?.label ||
    selectedModelOption?.label ||
    (model
      ? provider === 'kimi'
        ? formatKimiModelLabel(model, kimiModelConfig)
        : provider === 'grok'
          ? formatGrokModelLabel(model, grokModelConfig)
          : model
      : 'Default');

  const [claudeReasoningEffort, setClaudeReasoningEffortState] = useState<ClaudeReasoningEffort | null>(() => {
    if (provider !== 'claude') return null;
    return input?.claudeReasoningEffort || loadPreferredClaudeReasoningEffort(model) || getDefaultClaudeReasoningEffort(model);
  });

  const [codexReasoningEffort, setCodexReasoningEffortState] = useState<CodexReasoningEffort | null>(() => {
    if (provider !== 'codex' || !model) return null;
    const preferred = loadPreferredCodexReasoningEffort(model);
    if (preferred) return preferred;
    return getDefaultCodexReasoningEffort(codexModelConfig, model) || null;
  });

  // Sync Claude reasoning effort when model changes
  useEffect(() => {
    if (provider === 'claude') {
      setClaudeReasoningEffortState(
        input?.claudeReasoningEffort || loadPreferredClaudeReasoningEffort(model) || getDefaultClaudeReasoningEffort(model)
      );
    } else {
      setClaudeReasoningEffortState(null);
    }
  }, [provider, model, input?.claudeReasoningEffort]);

  const setClaudeReasoningEffort = useCallback(
    (effort: ClaudeReasoningEffort) => {
      setClaudeReasoningEffortState(effort);
      savePreferredClaudeReasoningEffort(model, effort);
    },
    [model]
  );

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
    if (!codexModelConfig) return [];
    return codexModelConfig.availableModels;
  }, [codexModelConfig]);

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

  const [claudePermissionMode, setClaudePermissionModeState] = useState<ClaudePermissionMode>(() =>
    normalizeClaudePermissionMode(input?.claudePermissionMode || loadPreferredClaudePermissionMode())
  );
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('defaultPermissions');
  const [kimiPermissionMode, setKimiPermissionModeState] = useState<KimiPermissionMode>(() =>
    loadPreferredKimiPermissionMode()
  );
  const [opencodePermissionMode, setOpencodePermissionModeState] = useState<OpenCodePermissionMode>(() =>
    input?.opencodePermissionMode || loadPreferredOpencodePermissionMode()
  );

  useEffect(() => {
    setClaudePermissionModeState(
      normalizeClaudePermissionMode(input?.claudePermissionMode || loadPreferredClaudePermissionMode())
    );
  }, [input?.claudePermissionMode, input?.selectionKey]);

  useEffect(() => {
    setOpencodePermissionModeState(input?.opencodePermissionMode || loadPreferredOpencodePermissionMode());
  }, [input?.opencodePermissionMode, input?.selectionKey]);

  const setClaudePermissionMode = useCallback((mode: ClaudePermissionMode) => {
    const normalized = normalizeClaudePermissionMode(mode);
    setClaudePermissionModeState(normalized);
    savePreferredClaudePermissionMode(normalized);
  }, []);

  const setKimiPermissionMode = useCallback((mode: KimiPermissionMode) => {
    setKimiPermissionModeState(mode);
    savePreferredKimiPermissionMode(mode);
  }, []);

  const setOpencodePermissionMode = useCallback((mode: OpenCodePermissionMode) => {
    setOpencodePermissionModeState(mode);
    savePreferredOpencodePermissionMode(mode);
  }, []);

  return {
    provider,
    model,
    compatibleProviderId,
    allAgentModelOptions,
    modelOptions,
    modelSetup,
    selectedModelOption,
    selectedModelLabel,
    selectAgent,
    selectModel,
    codexModelConfig,
    codexModels,
    claudeReasoningEffort,
    setClaudeReasoningEffort,
    codexReasoningEffort,
    setCodexReasoningEffort,
    codexFastMode,
    setCodexFastMode,
    claudePermissionMode,
    setClaudePermissionMode,
    codexPermissionMode,
    setCodexPermissionMode,
    kimiPermissionMode,
    setKimiPermissionMode,
    opencodePermissionMode,
    setOpencodePermissionMode,
  };
}
