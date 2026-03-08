import { useEffect, useState } from 'react';
import type { ClaudeModelConfig } from '../types';
import { CLAUDE_MODEL_PRESETS } from '../utils/claude-model';

const FALLBACK_CONFIG: ClaudeModelConfig = {
  defaultModel: null,
  options: CLAUDE_MODEL_PRESETS,
};

export function useClaudeModelConfig() {
  const [config, setConfig] = useState<ClaudeModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = () =>
      window.electron
        .getClaudeModelConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(nextConfig);
          }
        })
        .catch((error) => {
          console.error('Failed to load Claude model config:', error);
        });

    void loadConfig();

    const handleCompatibleProviderUpdated = () => {
      void loadConfig();
    };
    window.addEventListener('claude-compatible-provider-updated', handleCompatibleProviderUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener('claude-compatible-provider-updated', handleCompatibleProviderUpdated);
    };
  }, []);

  return config;
}
