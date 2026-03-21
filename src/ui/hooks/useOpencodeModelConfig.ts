import { useEffect, useRef, useState } from 'react';
import type { OpenCodeModelConfig } from '../types';

const FALLBACK_CONFIG: OpenCodeModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

function normalizeOpencodeModelConfig(raw: Partial<OpenCodeModelConfig> | null | undefined): OpenCodeModelConfig {
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
      ? raw.availableModels.map((model) => ({
          name: model.name,
          enabled: Boolean(model.enabled),
          isDefault: Boolean(model.isDefault),
        }))
      : Array.from(new Set([defaultModel, ...options].filter((value): value is string => Boolean(value)))).map(
          (name) => ({
            name,
            enabled: true,
            isDefault: defaultModel === name,
          })
        );

  return {
    defaultModel,
    options,
    availableModels,
  };
}

export function useOpencodeModelConfig() {
  const [config, setConfig] = useState<OpenCodeModelConfig>(FALLBACK_CONFIG);
  const latestRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () => {
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;

      return window.electron
        .getOpencodeModelConfig()
        .then((nextConfig) => {
          if (!cancelled && latestRequestIdRef.current === requestId) {
            setConfig(normalizeOpencodeModelConfig(nextConfig));
          }
        })
        .catch((error) => {
          console.error('Failed to load OpenCode model config:', error);
        });
    };

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('opencode-model-config-updated', handleUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('opencode-model-config-updated', handleUpdated);
    };
  }, []);

  return config;
}
