import { useEffect, useState } from 'react';
import type { ClaudeCompatibleProviderConfig } from '../types';

const DEFAULT_CONFIG: ClaudeCompatibleProviderConfig = {
  enabled: false,
  baseUrl: '',
  authType: 'api_key',
  secret: '',
  model: '',
};

export function useCompatibleProviderConfig() {
  const [config, setConfig] = useState<ClaudeCompatibleProviderConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = () =>
      window.electron
        .getClaudeCompatibleProviderConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(nextConfig);
          }
        })
        .catch((error) => {
          console.error('Failed to load compatible provider config:', error);
        });

    void loadConfig();

    const handleUpdated = () => {
      void loadConfig();
    };

    window.addEventListener('claude-compatible-provider-updated', handleUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('claude-compatible-provider-updated', handleUpdated);
    };
  }, []);

  return config;
}
