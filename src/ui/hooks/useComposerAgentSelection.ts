import { rendererStateStorage } from '../utils/renderer-state-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProvider, ClaudeCompatibleProviderId, SettingsTab } from '../types';
import { useClaudeModelConfig } from './useClaudeModelConfig';
import { useCodexModelConfig } from './useCodexModelConfig';
import { useOpencodeModelConfig } from './useOpencodeModelConfig';
import { useKimiModelConfig } from './useKimiModelConfig';
import { useGrokModelConfig } from './useGrokModelConfig';
import { usePiModelConfig } from './usePiModelConfig';
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
  GrokReasoningEffort,
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
  getDefaultGrokReasoningEffort,
  loadPreferredGrokReasoningEffort,
  savePreferredGrokReasoningEffort,
} from '../utils/grok-reasoning';
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
const PI_MODEL_STORAGE_KEY = 'cowork.preferredPiModel';

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
  const raw = rendererStateStorage.getItem(KIMI_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredKimiModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    rendererStateStorage.removeItem(KIMI_MODEL_STORAGE_KEY);
    return;
  }
  rendererStateStorage.setItem(KIMI_MODEL_STORAGE_KEY, model);
}

function loadPreferredGrokModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = rendererStateStorage.getItem(GROK_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredGrokModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    rendererStateStorage.removeItem(GROK_MODEL_STORAGE_KEY);
    return;
  }
  rendererStateStorage.setItem(GROK_MODEL_STORAGE_KEY, model);
}

function loadPreferredPiModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = rendererStateStorage.getItem(PI_MODEL_STORAGE_KEY);
  return raw?.trim() || null;
}

function savePreferredPiModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    rendererStateStorage.removeItem(PI_MODEL_STORAGE_KEY);
    return;
  }
  rendererStateStorage.setItem(PI_MODEL_STORAGE_KEY, model);
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

/**
 * Resolve a model id for picker/session state.
 * - Prefer explicit session model, then preferred, then config default.
 * - While the model list is still empty (config loading), still accept those
 *   candidates so the composer does not flash the empty "Default" option.
 * - If the list is loaded and an explicit session model is missing from it
 *   (stale list), keep the session model instead of clearing to null.
 */
export function resolveListedOrPendingModel(
  requestedModel: string | null | undefined,
  preferredModel: string | null | undefined,
  defaultModel: string | null | undefined,
  listedValues: Iterable<string>
): string | null {
  const nonEmptyListed = new Set(
    Array.from(listedValues)
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const candidates = [requestedModel, preferredModel, defaultModel]
    .map((value) => value?.trim() || null)
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (nonEmptyListed.size === 0 || nonEmptyListed.has(candidate)) {
      return candidate;
    }
  }

  if (requestedModel?.trim()) {
    return requestedModel.trim();
  }
  return null;
}

function resolveConfiguredKimiModel(
  requestedModel: string | null | undefined,
  config: ReturnType<typeof useKimiModelConfig>
): string | null {
  const options = buildKimiModelOptions(config);
  return resolveListedOrPendingModel(
    requestedModel,
    loadPreferredKimiModel(),
    config.defaultModel,
    options.map((option) => option.value)
  );
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
  return resolveListedOrPendingModel(
    requestedModel,
    loadPreferredGrokModel(),
    config.defaultModel,
    options.map((option) => option.value)
  );
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

function formatPiModelLabel(value: string, config: ReturnType<typeof usePiModelConfig>): string {
  const match = config.availableModels.find((model) => model.name === value);
  return match?.label || value;
}

function buildPiModelOptions(config: ReturnType<typeof usePiModelConfig>): ComposerModelOption[] {
  const defaultOption: ComposerModelOption = {
    key: 'pi:default',
    value: '',
    label: 'Default',
    description: config.defaultModel
      ? `Use ${formatPiModelLabel(config.defaultModel, config)}`
      : 'Use Pi default model',
  };
  const models = config.availableModels.length > 0
    ? config.availableModels
    : config.options.map((name) => ({ name, label: name, provider: null, enabled: true, isDefault: config.defaultModel === name }));
  const explicitOptions = models
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      key: `pi:${model.name}`,
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

function resolveConfiguredPiModel(
  requestedModel: string | null | undefined,
  config: ReturnType<typeof usePiModelConfig>
): string | null {
  const options = buildPiModelOptions(config);
  const optionValues = new Set(options.map((option) => option.value.trim()));
  const candidates = [requestedModel, loadPreferredPiModel()];
  for (const candidate of candidates) {
    const normalized = candidate?.trim() || null;
    if (normalized && optionValues.has(normalized)) {
      return normalized;
    }
  }
  return null;
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
  grokReasoningEffort?: GrokReasoningEffort | null;
}) {
  const claudeModelConfig = useClaudeModelConfig();
  const codexModelConfig = useCodexModelConfig();
  const opencodeModelConfig = useOpencodeModelConfig();
  const kimiModelConfig = useKimiModelConfig();
  const grokModelConfig = useGrokModelConfig();
  const piModelConfig = usePiModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const [provider, setProviderState] = useState<AgentProvider>(() => input?.provider || loadPreferredProvider());
  const [model, setModelState] = useState<string | null>(() => {
    const explicit = input?.model?.trim() || null;
    if (explicit) return explicit;
    // Draft/new sessions often have no model field yet — seed from preferred
    // so the first paint never flashes the empty "Default" option.
    const initialProvider = input?.provider || loadPreferredProvider();
    if (initialProvider === 'grok') return loadPreferredGrokModel();
    if (initialProvider === 'kimi') return loadPreferredKimiModel();
    if (initialProvider === 'codex') return loadPreferredCodexModel();
    if (initialProvider === 'opencode') return loadPreferredOpencodeModel();
    if (initialProvider === 'pi') return loadPreferredPiModel();
    if (initialProvider === 'claude') return loadPreferredClaudeModel();
    return null;
  });
  const [compatibleProviderId, setCompatibleProviderId] = useState<ClaudeCompatibleProviderId | null>(
    () => input?.compatibleProviderId || null
  );
  // Tracks which selectionKey the provider/model state currently belongs to.
  // Initialized to the current key so the first paint of a fresh composer does
  // not wait a frame for useEffect before applying session/preferred model.
  const [appliedSelectionKey, setAppliedSelectionKey] = useState<string>(
    () => input?.selectionKey ?? '__default__'
  );

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
      codex: buildCodexModelOptions(codexModelConfig).map((option) => {
        const meta = codexModelConfig.availableModels.find((entry) => entry.name === option);
        return {
          key: `codex:${option}`,
          value: option,
          label: formatCodexModelLabel(option, meta?.label),
        };
      }),
      opencode: buildOpencodeComposerModelOptions(opencodeModelConfig),
      kimi: buildKimiModelOptions(kimiModelConfig),
      grok: buildGrokModelOptions(grokModelConfig),
      pi: buildPiModelOptions(piModelConfig),
    };
  }, [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig, piModelConfig]);

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
      return buildCodexModelOptions(codexModelConfig).map((option) => {
        const meta = codexModelConfig.availableModels.find((entry) => entry.name === option);
        return {
          key: `codex:${option}`,
          value: option,
          label: formatCodexModelLabel(option, meta?.label),
        };
      });
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

    if (provider === 'pi') {
      return buildPiModelOptions(piModelConfig);
    }

    return [];
  }, [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig, piModelConfig, provider]);

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

      if (nextProvider === 'pi') {
        return {
          model: resolveConfiguredPiModel(normalizedRequestedModel, piModelConfig),
          compatibleProviderId: null,
        };
      }

      return {
        model: null,
        compatibleProviderId: null,
      };
    },
    [claudeModelConfig, codexModelConfig, compatibleOptions, opencodeModelConfig, kimiModelConfig, grokModelConfig, piModelConfig]
  );

  // Apply session switches during render so the first painted frame already
  // shows the target session's provider/model (avoids a one-frame "Default"
  // flash after switching threads).
  const selectionKey = input?.selectionKey ?? '__default__';
  if (appliedSelectionKey !== selectionKey) {
    setAppliedSelectionKey(selectionKey);
    const nextProvider = input?.provider || loadPreferredProvider();
    const nextSelection = resolveModelForProvider(
      nextProvider,
      input?.model,
      input?.compatibleProviderId
    );
    setProviderState(nextProvider);
    setModelState(nextSelection.model);
    setCompatibleProviderId(nextSelection.compatibleProviderId);
  }

  // Keep provider/model in sync when the active session's own fields change
  // without a selectionKey change (e.g. server assigns model after start).
  useEffect(() => {
    if ((input?.selectionKey ?? '__default__') !== appliedSelectionKey) {
      return;
    }
    if (input?.provider && input.provider !== provider) {
      setProviderState(input.provider);
    }
    if (input?.model !== undefined) {
      const nextSelection = resolveModelForProvider(
        input?.provider || provider,
        input.model,
        input.compatibleProviderId
      );
      if (
        nextSelection.model !== model ||
        nextSelection.compatibleProviderId !== (compatibleProviderId || null)
      ) {
        setModelState(nextSelection.model);
        setCompatibleProviderId(nextSelection.compatibleProviderId);
      }
    }
  }, [
    appliedSelectionKey,
    compatibleProviderId,
    input?.compatibleProviderId,
    input?.model,
    input?.provider,
    input?.selectionKey,
    model,
    provider,
    resolveModelForProvider,
  ]);

  useEffect(() => {
    if (model) {
      return;
    }
    const nextSelection = resolveModelForProvider(provider, input?.model, input?.compatibleProviderId);
    if (nextSelection.model) {
      setModelState(nextSelection.model);
      setCompatibleProviderId(nextSelection.compatibleProviderId);
    }
  }, [input?.compatibleProviderId, input?.model, model, provider, resolveModelForProvider]);

  useEffect(() => {
    const normalizedModel = model?.trim() || null;
    // Only treat a model as "configured" when it matches a non-empty option.
    // Matching the empty "Default" option while model is null was preventing
    // preferred-model resolution and left the trigger stuck on "Default".
    const selectedModelStillConfigured = modelOptions.some(
      (option) => {
        const optionValue = option.value.trim() || null;
        if (!optionValue) return false;
        return (
          optionValue === normalizedModel &&
          (option.compatibleProviderId || null) === (compatibleProviderId || null)
        );
      }
    );
    if (selectedModelStillConfigured) {
      return;
    }
    if (!normalizedModel && modelOptions.every((option) => !(option.value.trim()))) {
      return;
    }

    const nextSelection = resolveModelForProvider(provider, input?.model, input?.compatibleProviderId);
    if (
      nextSelection.model !== model ||
      nextSelection.compatibleProviderId !== (compatibleProviderId || null)
    ) {
      setModelState(nextSelection.model);
      setCompatibleProviderId(nextSelection.compatibleProviderId);
    }
  }, [
    compatibleProviderId,
    input?.compatibleProviderId,
    input?.model,
    model,
    modelOptions,
    provider,
    resolveModelForProvider,
  ]);

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
      } else if (provider === 'pi') {
        savePreferredPiModel(nextModel);
      }
    },
    [provider]
  );

  const selectedModelOption = useMemo(() => {
    // Unresolved (null) must not bind to the empty-value "Default" option —
    // that was the visible one-frame "Default" flash on session switches.
    if (model == null) {
      return null;
    }
    const normalizedModel = model.trim() || null;
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
    // Only show setup CTA when there is no resolvable model to display.
    const hasConcreteModels = modelOptions.some((option) => Boolean(option.value.trim()));
    if (hasConcreteModels || model) {
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
  }, [model, modelOptions, provider]);

  const selectedModelLabel =
    modelSetup?.label ||
    selectedModelOption?.label ||
    (model
      ? provider === 'kimi'
        ? formatKimiModelLabel(model, kimiModelConfig)
        : provider === 'grok'
          ? formatGrokModelLabel(model, grokModelConfig)
          : model
      : provider === 'grok'
        ? formatGrokModelLabel(
            resolveConfiguredGrokModel(null, grokModelConfig) || '',
            grokModelConfig
          ) || 'Grok'
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

  const [grokReasoningEffort, setGrokReasoningEffortState] = useState<GrokReasoningEffort | null>(() => {
    if (provider !== 'grok') return null;
    return (
      input?.grokReasoningEffort ||
      loadPreferredGrokReasoningEffort(model) ||
      getDefaultGrokReasoningEffort(model)
    );
  });

  // Sync Grok reasoning effort when model/provider changes
  useEffect(() => {
    if (provider === 'grok') {
      setGrokReasoningEffortState(
        input?.grokReasoningEffort ||
          loadPreferredGrokReasoningEffort(model) ||
          getDefaultGrokReasoningEffort(model)
      );
    } else {
      setGrokReasoningEffortState(null);
    }
  }, [provider, model, input?.grokReasoningEffort]);

  const setGrokReasoningEffort = useCallback(
    (effort: GrokReasoningEffort) => {
      setGrokReasoningEffortState(effort);
      if (model) {
        savePreferredGrokReasoningEffort(model, effort);
      }
    },
    [model]
  );

  const codexModels = useMemo(() => {
    if (!codexModelConfig) return [];
    // Keep enabled models in Codex cache order (already priority-sorted server-side).
    const enabled = codexModelConfig.availableModels.filter((model) => model.enabled !== false);
    return enabled.length > 0 ? enabled : codexModelConfig.availableModels;
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
    grokReasoningEffort,
    setGrokReasoningEffort,
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
