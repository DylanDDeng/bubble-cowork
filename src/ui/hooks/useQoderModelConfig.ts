import { useEffect, useState } from 'react';
import type { QoderModelConfig, QoderModelOption } from '../types';

const FALLBACK_CONFIG: QoderModelConfig = {
  defaultModel: null,
  options: [],
  models: [],
};

function normalizeQoderModelOption(model: Partial<QoderModelOption>): QoderModelOption | null {
  const value = model.value?.trim();
  if (!value) return null;
  return {
    value,
    displayName: model.displayName?.trim() || value,
    description: model.description?.trim() || undefined,
    isVl: model.isVl === true,
    isEnabled: model.isEnabled !== false,
    isDefault: Boolean(model.isDefault),
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    availableContextWindows: Array.isArray(model.availableContextWindows)
      ? model.availableContextWindows.filter((w): w is number => typeof w === 'number')
      : undefined,
    maxInputTokens: typeof model.maxInputTokens === 'number' ? model.maxInputTokens : null,
    maxOutputTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : null,
    efforts: Array.isArray(model.efforts) ? model.efforts.filter((e): e is string => typeof e === 'string') : undefined,
    defaultEffort: model.defaultEffort ?? null,
    priceFactor: typeof model.priceFactor === 'number' ? model.priceFactor : null,
    source: model.source === 'user' ? 'user' : 'system',
  };
}

function normalizeQoderModelConfig(raw: Partial<QoderModelConfig> | null | undefined): QoderModelConfig {
  const models = (raw?.models || [])
    .map(normalizeQoderModelOption)
    .filter((model): model is QoderModelOption => Boolean(model));
  const defaultModel =
    raw?.defaultModel?.trim() || models.find((model) => model.isDefault)?.value || models[0]?.value || null;
  const options = Array.from(
    new Set(
      (raw?.options && raw.options.length > 0 ? raw.options : models.map((model) => model.value))
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  return { defaultModel, options, models };
}

export function useQoderModelConfig() {
  const [config, setConfig] = useState<QoderModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getQoderModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeQoderModelConfig(nextConfig));
          }
        })
        .catch((error) => {
          console.error('Failed to load Qoder model config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('qoder-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('qoder-model-config-updated', handleUpdated);
    };
  }, []);

  return config;
}
