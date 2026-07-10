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
          label: model.label?.trim() || undefined,
          enabled: model.enabled !== false,
          isDefault: Boolean(model.isDefault),
          defaultReasoningEffort: model.defaultReasoningEffort || null,
          supportedReasoningLevels: (model.supportedReasoningLevels || []).map((level) => ({
            effort: level.effort,
            description: level.description,
          })),
          supportsFastMode: model.supportsFastMode === true,
          priority: typeof model.priority === 'number' ? model.priority : null,
        }))
      : Array.from(new Set([defaultModel, ...options].filter((value): value is string => Boolean(value)))).map(
          (name) => ({
            name,
            label: undefined,
            enabled: true,
            isDefault: defaultModel === name,
            defaultReasoningEffort,
            supportedReasoningLevels: [],
            supportsFastMode: false,
            priority: null,
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
    if (typeof window === 'undefined' || !window.electron?.getCodexModelConfig) {
      return;
    }

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
    // Codex rewrites models_cache.json during sessions / app-server use; refresh
    // when the window is focused so Sol/Terra/Luna appear without a full restart.
    const handleFocus = () => {
      void loadConfig();
    };
    window.addEventListener('codex-model-config-updated', handleUpdated);
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('codex-model-config-updated', handleUpdated);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return config;
}
