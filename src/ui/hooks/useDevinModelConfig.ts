import { useEffect, useState } from 'react';
import type { DevinModelConfig } from '../types';

const FALLBACK_CONFIG: DevinModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// Every composer mounts this hook; share one catalog read (a `devin models
// list` round trip in the main process) across all of them.
let sharedRequest: Promise<DevinModelConfig> | null = null;

function normalizeDevinModelConfig(raw: Partial<DevinModelConfig> | null | undefined): DevinModelConfig {
  const availableModels = (raw?.availableModels || []).filter((model) => Boolean(model?.id?.trim()));
  const defaultModel = raw?.defaultModel?.trim() || null;
  const options = Array.from(
    new Set(
      [defaultModel, ...(raw?.options || []), ...availableModels.map((model) => model.id)]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
  return { defaultModel, options, availableModels };
}

export function useDevinModelConfig() {
  const [config, setConfig] = useState<DevinModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    sharedRequest ??= window.electron.getDevinModelConfig().then((next) => {
      const normalized = normalizeDevinModelConfig(next);
      // A failed read (CLI missing, offline) must not stick for the session.
      if (normalized.options.length === 0) sharedRequest = null;
      return normalized;
    });
    sharedRequest
      .then((nextConfig) => {
        if (!cancelled) setConfig(nextConfig);
      })
      .catch(() => {
        sharedRequest = null;
        // CLI missing: the picker falls back to the provider default row.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
