import { useEffect, useState } from 'react';
import type { KimiModelConfig } from '../types';
import { rendererStateStorage } from '../utils/renderer-state-storage';

const FALLBACK_CONFIG: KimiModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// Last-good config so the first paint already has real labels and thinking
// tiers — without it the composer briefly shows raw model ids / stale
// defaults until the async IPC lands (visible flicker on agent switch).
const CACHE_STORAGE_KEY = 'cowork.kimiModelConfigCache';

function loadCachedConfig(): KimiModelConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = rendererStateStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    return normalizeKimiModelConfig(JSON.parse(raw) as Partial<KimiModelConfig>);
  } catch {
    return null;
  }
}

function saveCachedConfig(config: KimiModelConfig): void {
  if (typeof window === 'undefined') return;
  try {
    rendererStateStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // cache is best-effort
  }
}

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
          .map((model): KimiModelConfig['availableModels'][number] | null => {
            const name = model.name?.trim();
            if (!name) return null;
            const supportEfforts = (model.supportEfforts || []).filter(
              (value): value is string => typeof value === 'string' && value.trim().length > 0
            );
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
              // Thinking-tier metadata (k3-class) — dropping these would
              // silently degrade the picker to the on/off fallback.
              ...(supportEfforts.length > 0 ? { supportEfforts } : {}),
              ...(typeof model.defaultEffort === 'string' && model.defaultEffort.trim()
                ? { defaultEffort: model.defaultEffort.trim() }
                : {}),
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
  const [config, setConfig] = useState<KimiModelConfig>(() => loadCachedConfig() || FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getKimiModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            const normalized = normalizeKimiModelConfig(nextConfig);
            setConfig(normalized);
            saveCachedConfig(normalized);
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
