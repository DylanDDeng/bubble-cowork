import { useEffect, useState } from 'react';
import type { DeepseekModelConfig } from '../types';

const FALLBACK_CONFIG: DeepseekModelConfig = {
  defaultModel: null,
  options: [],
};

function normalizeDeepseekModelConfig(
  raw: Partial<DeepseekModelConfig> | null | undefined
): DeepseekModelConfig {
  const defaultModel = raw?.defaultModel?.trim() || null;
  const options = Array.from(
    new Set(
      [defaultModel, ...(raw?.options || [])]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  return { defaultModel, options };
}

export function useDeepseekModelConfig() {
  const [config, setConfig] = useState<DeepseekModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getDeepseekModelConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(normalizeDeepseekModelConfig(nextConfig));
        }
      })
      .catch(() => {
        // Missing profile: the picker falls back to the provider default row.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
