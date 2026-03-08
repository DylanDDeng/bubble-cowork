import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ClaudeCompatibleProviderConfig } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'claude-compatible-provider.json');

export function getDefaultCompatibleProviderConfig(): ClaudeCompatibleProviderConfig {
  return {
    enabled: false,
    baseUrl: '',
    authType: 'api_key',
    secret: '',
    model: '',
  };
}

export function loadCompatibleProviderConfig(): ClaudeCompatibleProviderConfig {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return getDefaultCompatibleProviderConfig();
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ClaudeCompatibleProviderConfig>;
    return {
      ...getDefaultCompatibleProviderConfig(),
      ...parsed,
    };
  } catch {
    return getDefaultCompatibleProviderConfig();
  }
}

export function saveCompatibleProviderConfig(config: ClaudeCompatibleProviderConfig): void {
  writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf-8');
}

export function getActiveCompatibleProviderConfig(): ClaudeCompatibleProviderConfig | null {
  const config = loadCompatibleProviderConfig();
  if (!config.enabled || !config.baseUrl.trim() || !config.secret.trim() || !config.model.trim()) {
    return null;
  }
  return {
    ...config,
    baseUrl: config.baseUrl.trim(),
    secret: config.secret.trim(),
    model: config.model.trim(),
  };
}

export function applyCompatibleProviderEnv(
  env: Record<string, string | undefined>,
  requestedModel?: string | null
): {
  env: Record<string, string | undefined>;
  forcedModel?: string;
} {
  const config = getActiveCompatibleProviderConfig();
  if (!config) {
    return { env };
  }

  const normalizedRequestedModel = requestedModel?.trim();
  if (normalizedRequestedModel && normalizedRequestedModel !== config.model) {
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

  return {
    env: nextEnv,
    forcedModel,
  };
}
