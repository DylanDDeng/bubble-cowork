import { useEffect, useMemo, useState } from 'react';
import type {
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProvidersConfig,
} from '../types';

export interface CompatibleProviderOption {
  id: ClaudeCompatibleProviderId;
  label: string;
  model: string;
}

const COMPATIBLE_PROVIDER_LABELS: Record<ClaudeCompatibleProviderId, string> = {
  minimax: 'MiniMax (CN)',
  zhipu: 'Zhipu AI',
  moonshot: 'Moonshot AI',
  deepseek: 'DeepSeek',
};

const DEFAULT_CONFIG: ClaudeCompatibleProvidersConfig = {
  providers: {
    minimax: {
      enabled: false,
      baseUrl: 'https://api.minimax.io/anthropic',
      authType: 'auth_token',
      secret: '',
      model: 'MiniMax-M2.5',
    },
    zhipu: {
      enabled: false,
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authType: 'auth_token',
      secret: '',
      model: 'glm-5',
    },
    moonshot: {
      enabled: false,
      baseUrl: 'https://api.moonshot.cn/anthropic',
      authType: 'auth_token',
      secret: '',
      model: 'kimi-k2.5',
      smallFastModel: '',
    },
    deepseek: {
      enabled: false,
      baseUrl: 'https://api.deepseek.com/anthropic',
      authType: 'auth_token',
      secret: '',
      model: '',
      smallFastModel: '',
    },
  },
};

type LegacyCompatibleProviderConfig = Partial<ClaudeCompatibleProviderConfig> | null | undefined;

function normalizeProvider(
  providerId: ClaudeCompatibleProviderId,
  provider: LegacyCompatibleProviderConfig
): ClaudeCompatibleProviderConfig {
  const fallback = DEFAULT_CONFIG.providers[providerId];
  return {
    ...fallback,
    ...provider,
    authType: 'auth_token',
  };
}

export function normalizeCompatibleProvidersConfig(
  raw: unknown
): ClaudeCompatibleProvidersConfig {
  if (raw && typeof raw === 'object' && 'providers' in raw) {
    const providers = (raw as { providers?: Record<string, LegacyCompatibleProviderConfig> }).providers;
    return {
      providers: {
        minimax: normalizeProvider('minimax', providers?.minimax),
        zhipu: normalizeProvider('zhipu', providers?.zhipu),
        moonshot: normalizeProvider('moonshot', providers?.moonshot),
        deepseek: normalizeProvider('deepseek', providers?.deepseek),
      },
    };
  }

  return {
    providers: {
      minimax: normalizeProvider('minimax', raw as LegacyCompatibleProviderConfig),
      zhipu: normalizeProvider('zhipu', undefined),
      moonshot: normalizeProvider('moonshot', undefined),
      deepseek: normalizeProvider('deepseek', undefined),
    },
  };
}

export function getEnabledCompatibleProviderOptions(
  config: ClaudeCompatibleProvidersConfig
): CompatibleProviderOption[] {
  const normalized = normalizeCompatibleProvidersConfig(config);
  return (Object.entries(normalized.providers) as Array<
    [ClaudeCompatibleProviderId, ClaudeCompatibleProvidersConfig['providers'][ClaudeCompatibleProviderId]]
  >)
    .filter(([, provider]) => provider.enabled && provider.model.trim())
    .map(([id, provider]) => ({
      id,
      label: COMPATIBLE_PROVIDER_LABELS[id],
      model: provider.model.trim(),
    }));
}

export function useCompatibleProviderConfig() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = () =>
      window.electron
        .getClaudeCompatibleProviderConfig()
        .then((nextConfig) => {
          if (!cancelled) {
            setConfig(normalizeCompatibleProvidersConfig(nextConfig));
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

  const compatibleOptions = useMemo(
    () => getEnabledCompatibleProviderOptions(config),
    [config]
  );

  return { config, compatibleOptions };
}
