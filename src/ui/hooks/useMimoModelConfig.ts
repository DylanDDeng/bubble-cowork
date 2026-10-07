import { useEffect, useState } from 'react';
import type { MimoModelConfig } from '../types';

const FALLBACK_CONFIG: MimoModelConfig = {
  defaultModel: null,
  options: [],
  availableModels: [],
};

// Every composer mounts this hook; share one catalog read (a `mimo models`
// run in the main process) across all of them.
let sharedRequest: Promise<MimoModelConfig> | null = null;

function normalizeMimoModelConfig(raw: Partial<MimoModelConfig> | null | undefined): MimoModelConfig {
  const availableModels = (raw?.availableModels || [])
    .filter((model) => Boolean(model?.id?.trim()))
    .map((model) => ({ ...model, reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [] }));
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

export function useMimoModelConfig() {
  const [config, setConfig] = useState<MimoModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    sharedRequest ??= window.electron.getMimoModelConfig().then((next) => {
      const normalized = normalizeMimoModelConfig(next);
      // A failed read (CLI missing) must not stick for the session.
      if (normalized.options.length === 0) sharedRequest = null;
      return normalized;
    });
    sharedRequest
      .then((nextConfig) => {
        if (!cancelled) setConfig(nextConfig);
      })
      .catch(() => {
        sharedRequest = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
