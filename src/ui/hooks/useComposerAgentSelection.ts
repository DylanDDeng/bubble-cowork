import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProvider, ClaudeCompatibleProviderId } from '../types';
import { useClaudeModelConfig } from './useClaudeModelConfig';
import { useCodexModelConfig } from './useCodexModelConfig';
import { useOpencodeModelConfig } from './useOpencodeModelConfig';
import { useCompatibleProviderConfig } from './useCompatibleProviderConfig';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import {
  buildClaudeModelOptions,
  formatClaudeModelLabel,
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
  buildOpencodeModelOptions,
  formatOpencodeModelLabel,
  loadPreferredOpencodeModel,
  savePreferredOpencodeModel,
} from '../utils/opencode-model';
import {
  AEGIS_BUILT_IN_MODELS,
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

function buildAegisModelOptions(currentModel?: string | null): ComposerModelOption[] {
  const options = AEGIS_BUILT_IN_MODELS.map((model) => {
    const provider = getAegisBuiltInProvider(model.providerId);
    const encoded = `${model.providerId}:${model.id}`;
    return {
      key: `aegis:${encoded}`,
      value: encoded,
      label: model.name,
      description: provider?.name || model.providerId,
    };
  });

  const normalizedCurrent = currentModel?.trim();
  if (
    normalizedCurrent &&
    !options.some((option) => option.value === normalizedCurrent)
  ) {
    const selection = resolveAegisBuiltInModel(normalizedCurrent);
    options.unshift({
      key: `aegis:${selection.encoded}`,
      value: selection.encoded,
      label: formatAegisModelLabel(selection.encoded),
      description: getAegisBuiltInProvider(selection.providerId)?.name || selection.providerId,
    });
  }

  return options;
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
          console.error('Failed to load Aegis built-in model config:', error);
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
      const officialOptions = buildClaudeModelOptions(claudeModelConfig, [model]).map((option) => ({
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
      return [...officialOptions, ...compatible];
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

    return buildAegisModelOptions(model);
  }, [claudeModelConfig, codexModelConfig, compatibleOptions, model, opencodeModelConfig, provider]);

  const resolveModelForProvider = useCallback(
    (
      nextProvider: AgentProvider,
      requestedModel?: string | null,
      requestedCompatibleProviderId?: ClaudeCompatibleProviderId | null
    ): { model: string | null; compatibleProviderId: ClaudeCompatibleProviderId | null } => {
      const normalizedRequestedModel = requestedModel?.trim() || null;
      if (nextProvider === 'claude') {
        const preferredModel = loadPreferredClaudeModel();
        const nextModel =
          normalizedRequestedModel ||
          preferredModel ||
          claudeModelConfig.defaultModel ||
          buildClaudeModelOptions(claudeModelConfig)[0] ||
          null;
        return {
          model: nextModel,
          compatibleProviderId: resolveCompatibleProviderForModel(
            nextModel,
            requestedCompatibleProviderId || loadPreferredClaudeCompatibleProviderId(),
            compatibleOptions
          ),
        };
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

      const configModel = aegisConfig
        ? resolveAegisBuiltInModel(aegisConfig.model, aegisConfig.providerId).encoded
        : null;
      return {
        model: resolveAegisBuiltInModel(
          normalizedRequestedModel || loadPreferredAegisModel() || configModel
        ).encoded,
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
    return (
      modelOptions.find(
        (option) =>
          option.value === model &&
          (option.compatibleProviderId || null) === (compatibleProviderId || null)
      ) ||
      modelOptions.find((option) => option.value === model) ||
      null
    );
  }, [compatibleProviderId, model, modelOptions]);

  const selectedModelLabel =
    selectedModelOption?.label ||
    (model ? (provider === 'aegis' ? formatAegisModelLabel(model) : model) : 'Default');

  return {
    provider,
    model,
    compatibleProviderId,
    modelOptions,
    selectedModelOption,
    selectedModelLabel,
    selectAgent,
    selectModel,
  };
}
