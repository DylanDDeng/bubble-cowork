import { useEffect, useState } from 'react';
import type { GrokModelConfig } from '../types';

const FALLBACK_CONFIG: GrokModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

function normalizeGrokModelConfig(raw: Partial<GrokModelConfig> | null | undefined): GrokModelConfig {
  const defaultModel = raw?.defaultModel?.trim() || null;
  const options = Array.from(
    new Set(
      (raw?.options || [])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );

  const availableModels =
    raw?.availableModels && raw.availableModels.length > 0
      ? raw.availableModels
          .map((model) => {
            const name = model.name?.trim();
            if (!name) return null;
            return {
              name,
              label: model.label?.trim() || name,
              provider: model.provider?.trim() || null,
              enabled: model.enabled !== false,
              isDefault: Boolean(model.isDefault) || defaultModel === name,
              maxContextSize: typeof model.maxContextSize === 'number' ? model.maxContextSize : null,
              capabilities: (model.capabilities || []).filter(
                (value): value is string => typeof value === 'string' && value.trim().length > 0
              ),
            };
          })
          .filter((model): model is NonNullable<typeof model> => Boolean(model))
      : Array.from(new Set([defaultModel, ...options].filter((value): value is string => Boolean(value)))).map(
          (name) => ({
            name,
            label: name,
            provider: null,
            enabled: true,
            isDefault: defaultModel === name,
            maxContextSize: null,
            capabilities: [],
          })
        );

  return {
    defaultModel,
    options,
    availableModels,
  };
}

export function useGrokModelConfig() {
  const [config, setConfig] = useState<GrokModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getGrokModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeGrokModelConfig(nextConfig));
          }
        })
        .catch((error) => {
          console.error('Failed to load Grok model config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('grok-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('grok-model-config-updated', handleUpdated);
    };
  }, []);

  return config;
}
