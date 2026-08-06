import { useEffect, useMemo, useState } from 'react';
import type { BubbleModelConfig } from '../types';

const FALLBACK_CONFIG: BubbleModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

function normalizeBubbleModelConfig(
  raw: Partial<BubbleModelConfig> | null | undefined
): BubbleModelConfig {
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

export function useBubbleModelConfig() {
  const [config, setConfig] = useState<BubbleModelConfig>(FALLBACK_CONFIG);
  // First catalog load hits live provider endpoints (seconds on a cold
  // start); until it settles the picker shows a loading hint rather than a
  // misleading "No models configured".
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getBubbleModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeBubbleModelConfig(nextConfig));
            setLoaded(true);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setLoaded(true);
          }
          console.error('Failed to load Bubble model config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('bubble-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('bubble-model-config-updated', handleUpdated);
    };
  }, []);

  return useMemo(() => ({ ...config, loaded }), [config, loaded]);
}
