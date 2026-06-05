import { useEffect, useState } from 'react';
import type { KimiModelConfig } from '../types';

const FALLBACK_CONFIG: KimiModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

function normalizeKimiModelConfig(raw: Partial<KimiModelConfig> | null | undefined): KimiModelConfig {
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
          .filter((model): model is KimiModelConfig['availableModels'][number] => Boolean(model))
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

export function useKimiModelConfig() {
  const [config, setConfig] = useState<KimiModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getKimiModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeKimiModelConfig(nextConfig));
          }
        })
        .catch((error) => {
          console.error('Failed to load Kimi model config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('kimi-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('kimi-model-config-updated', handleUpdated);
    };
  }, []);

  return config;
}
