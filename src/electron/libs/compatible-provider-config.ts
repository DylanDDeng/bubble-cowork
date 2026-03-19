import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProvidersConfig,
} from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'claude-compatible-provider.json');

const COMPATIBLE_PROVIDER_DEFAULTS: Record<
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProviderConfig
> = {
  minimaxCn: {
    enabled: false,
    baseUrl: 'https://api.minimaxi.com/anthropic',
    authType: 'auth_token',
    secret: '',
    model: 'MiniMax-M2.5',
  },
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
  },
  deepseek: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/anthropic',
    authType: 'auth_token',
    secret: '',
    model: '',
    smallFastModel: '',
  },
};

export interface ResolvedCompatibleProviderConfig extends ClaudeCompatibleProviderConfig {
  id: ClaudeCompatibleProviderId;
}

function normalizeCompatibleProviderConfig(
  providerId: ClaudeCompatibleProviderId,
  config?: Partial<ClaudeCompatibleProviderConfig> | null
): ClaudeCompatibleProviderConfig {
  return {
    ...COMPATIBLE_PROVIDER_DEFAULTS[providerId],
    ...config,
    authType: config?.authType === 'api_key' ? 'api_key' : 'auth_token',
  };
}

export function getDefaultCompatibleProviderConfig(
  providerId: ClaudeCompatibleProviderId
): ClaudeCompatibleProviderConfig {
  return normalizeCompatibleProviderConfig(providerId);
}

export function getDefaultCompatibleProvidersConfig(): ClaudeCompatibleProvidersConfig {
  return {
    providers: {
      minimaxCn: getDefaultCompatibleProviderConfig('minimaxCn'),
      minimax: getDefaultCompatibleProviderConfig('minimax'),
      zhipu: getDefaultCompatibleProviderConfig('zhipu'),
      moonshot: getDefaultCompatibleProviderConfig('moonshot'),
      deepseek: getDefaultCompatibleProviderConfig('deepseek'),
    },
  };
}

function migrateLegacyConfig(
  parsed: Partial<ClaudeCompatibleProviderConfig>
): ClaudeCompatibleProvidersConfig {
  const defaults = getDefaultCompatibleProvidersConfig();
  defaults.providers.minimax = normalizeCompatibleProviderConfig('minimax', parsed);
  return defaults;
}

export function loadCompatibleProviderConfig(): ClaudeCompatibleProvidersConfig {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return getDefaultCompatibleProvidersConfig();
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as
      | Partial<ClaudeCompatibleProvidersConfig>
      | Partial<ClaudeCompatibleProviderConfig>;

    if ('providers' in parsed && parsed.providers) {
      return {
        providers: {
          minimaxCn: normalizeCompatibleProviderConfig('minimaxCn', parsed.providers.minimaxCn),
          minimax: normalizeCompatibleProviderConfig('minimax', parsed.providers.minimax),
          zhipu: normalizeCompatibleProviderConfig('zhipu', parsed.providers.zhipu),
          moonshot: normalizeCompatibleProviderConfig('moonshot', parsed.providers.moonshot),
          deepseek: normalizeCompatibleProviderConfig('deepseek', parsed.providers.deepseek),
        },
      };
    }

    return migrateLegacyConfig(parsed as Partial<ClaudeCompatibleProviderConfig>);
  } catch {
    return getDefaultCompatibleProvidersConfig();
  }
}

export function saveCompatibleProviderConfig(config: ClaudeCompatibleProvidersConfig): void {
  const normalized: ClaudeCompatibleProvidersConfig = {
    providers: {
      minimaxCn: normalizeCompatibleProviderConfig('minimaxCn', config.providers?.minimaxCn),
      minimax: normalizeCompatibleProviderConfig('minimax', config.providers?.minimax),
      zhipu: normalizeCompatibleProviderConfig('zhipu', config.providers?.zhipu),
      moonshot: normalizeCompatibleProviderConfig('moonshot', config.providers?.moonshot),
      deepseek: normalizeCompatibleProviderConfig('deepseek', config.providers?.deepseek),
    },
  };

  writeFileSync(CONFIG_PATH(), JSON.stringify(normalized, null, 2), 'utf-8');
}

export function getEnabledCompatibleProviderConfigs(): ResolvedCompatibleProviderConfig[] {
  const config = loadCompatibleProviderConfig();

  return (Object.entries(config.providers) as Array<
    [ClaudeCompatibleProviderId, ClaudeCompatibleProviderConfig]
  >)
    .filter(([, provider]) => {
      return (
        provider.enabled &&
        provider.baseUrl.trim().length > 0 &&
        provider.secret.trim().length > 0 &&
        provider.model.trim().length > 0
      );
    })
    .map(([id, provider]) => ({
      ...provider,
      id,
      baseUrl: provider.baseUrl.trim(),
      secret: provider.secret.trim(),
      model: provider.model.trim(),
    }));
}

export function getCompatibleProviderConfigByModel(
  requestedModel?: string | null,
  requestedProviderId?: ClaudeCompatibleProviderId | null
): ResolvedCompatibleProviderConfig | null {
  const normalizedRequestedModel = requestedModel?.trim();
  const enabledProviders = getEnabledCompatibleProviderConfigs();

  if (requestedProviderId) {
    const exactProvider = enabledProviders.find((provider) => provider.id === requestedProviderId);
    if (exactProvider) {
      return exactProvider;
    }
  }

  if (!normalizedRequestedModel) {
    return null;
  }

  return enabledProviders.find((provider) => provider.model === normalizedRequestedModel) || null;
}

export function applyCompatibleProviderEnv(
  env: Record<string, string | undefined>,
  requestedModel?: string | null,
  requestedProviderId?: ClaudeCompatibleProviderId | null
): {
  env: Record<string, string | undefined>;
  forcedModel?: string;
  matchedProviderId?: ClaudeCompatibleProviderId;
} {
  const config = getCompatibleProviderConfigByModel(requestedModel, requestedProviderId);
  if (!config) {
    return { env };
  }

  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (key.startsWith('ANTHROPIC_')) {
      delete nextEnv[key];
    }
  }

  nextEnv.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.authType === 'auth_token') {
    nextEnv.ANTHROPIC_AUTH_TOKEN = config.secret;
  } else {
    nextEnv.ANTHROPIC_API_KEY = config.secret;
  }

  const forcedModel = requestedModel?.trim() || config.model;
  nextEnv.ANTHROPIC_MODEL = forcedModel;
  nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = forcedModel;
  nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = forcedModel;
  nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = forcedModel;
  nextEnv.ANTHROPIC_REASONING_MODEL = forcedModel;
  if (config.smallFastModel?.trim()) {
    nextEnv.ANTHROPIC_SMALL_FAST_MODEL = config.smallFastModel.trim();
  }
  if (config.id === 'deepseek') {
    nextEnv.API_TIMEOUT_MS = '600000';
    nextEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  nextEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

  return {
    env: nextEnv,
    forcedModel,
    matchedProviderId: config.id,
  };
}
