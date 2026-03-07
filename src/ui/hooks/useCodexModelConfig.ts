import { useEffect, useState } from 'react';
import type { CodexModelConfig } from '../types';

const FALLBACK_CONFIG: CodexModelConfig = {
  defaultModel: null,
  options: [],
};

export function useCodexModelConfig() {
  const [config, setConfig] = useState<CodexModelConfig>(FALLBACK_CONFIG);

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getCodexModelConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(nextConfig);
        }
      })
      .catch((error) => {
        console.error('Failed to load Codex model config:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
