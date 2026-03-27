import { useEffect, useState } from 'react';
import type { CodexModelConfig } from '../types';

const FALLBACK_CONFIG: CodexModelConfig = {
  defaultModel: null,
  defaultReasoningEffort: null,
  options: [],
  availableModels: [],
};

function normalizeCodexModelConfig(raw: Partial<CodexModelConfig> | null | undefined): CodexModelConfig {
  const defaultModel = raw?.defaultModel?.trim() || null;
  const defaultReasoningEffort = raw?.defaultReasoningEffort || null;
  const options = Array.from(
    new Set(
      (raw?.options || [])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );

  const availableModels =
    raw?.availableModels && raw.availableModels.length > 0
      ? raw.availableModels.map((model) => ({
          name: model.name,
          enabled: Boolean(model.enabled),
          isDefault: Boolean(model.isDefault),
          defaultReasoningEffort: model.defaultReasoningEffort || null,
          supportedReasoningLevels: (model.supportedReasoningLevels || []).map((level) => ({
            effort: level.effort,
            description: level.description,
          })),
        }))
      : Array.from(new Set([defaultModel, ...options].filter((value): value is string => Boolean(value)))).map(
          (name) => ({
            name,
            enabled: true,
            isDefault: defaultModel === name,
            defaultReasoningEffort,
            supportedReasoningLevels: [],
          })
        );

  return {
    defaultModel,
    defaultReasoningEffort,
    options,
    availableModels,
  };
}

export function useCodexModelConfig() {
  const [config, setConfig] = useState<CodexModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getCodexModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeCodexModelConfig(nextConfig));
          }
        })
        .catch((error) => {
          console.error('Failed to load Codex model config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('codex-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('codex-model-config-updated', handleUpdated);
    };
  }, []);

  return config;
}
