import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  AEGIS_BUILT_IN_DEFAULT_MODEL,
  AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  getAegisBuiltInProvider,
  resolveAegisBuiltInModel,
} from '../../shared/aegis-built-in-catalog';
import type { AegisBuiltInAgentConfig } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'aegis-built-in-agent.json');
const DEFAULT_PROVIDER = getAegisBuiltInProvider(AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID);

const DEFAULT_CONFIG: AegisBuiltInAgentConfig = {
  providerId: AEGIS_BUILT_IN_DEFAULT_PROVIDER_ID,
  baseUrl: DEFAULT_PROVIDER?.baseUrl || 'https://api.openai.com/v1',
  apiKey: '',
  model: AEGIS_BUILT_IN_DEFAULT_MODEL,
  temperature: 0.2,
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONFIG.temperature;
  }
  return Math.max(0, Math.min(2, value));
}

function normalizeMaxOutputTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

export function normalizeAegisBuiltInAgentConfig(input?: Partial<AegisBuiltInAgentConfig> | null): AegisBuiltInAgentConfig {
  const maxOutputTokens = normalizeMaxOutputTokens(input?.maxOutputTokens);
  const selection = resolveAegisBuiltInModel(input?.model, input?.providerId);
  const provider = getAegisBuiltInProvider(selection.providerId);
  return {
    providerId: selection.providerId,
    baseUrl: provider?.baseUrl
      || asString(input?.baseUrl).trim()
      || DEFAULT_CONFIG.baseUrl,
    apiKey: asString(input?.apiKey).trim(),
    model: selection.encoded,
    temperature: normalizeTemperature(input?.temperature),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

export function getDefaultAegisBuiltInAgentConfig(): AegisBuiltInAgentConfig {
  return normalizeAegisBuiltInAgentConfig();
}

export function loadAegisBuiltInAgentConfig(): AegisBuiltInAgentConfig {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return getDefaultAegisBuiltInAgentConfig();
  }

  try {
    return normalizeAegisBuiltInAgentConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
  } catch {
    return getDefaultAegisBuiltInAgentConfig();
  }
}

export function saveAegisBuiltInAgentConfig(config: AegisBuiltInAgentConfig): AegisBuiltInAgentConfig {
  const normalized = normalizeAegisBuiltInAgentConfig(config);
  writeFileSync(CONFIG_PATH(), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}
