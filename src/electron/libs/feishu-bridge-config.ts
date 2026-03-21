import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentProvider, FeishuBridgeConfig } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'feishu-bridge.json');

const DEFAULT_CONFIG: FeishuBridgeConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  defaultCwd: '',
  provider: 'claude',
  model: '',
  allowedUserIds: '',
  autoStart: false,
};

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'opencode' ? 'opencode' : value === 'codex' ? 'codex' : 'claude';
}

function normalizeConfig(parsed?: Partial<FeishuBridgeConfig> | null): FeishuBridgeConfig {
  return {
    enabled: parsed?.enabled === true,
    appId: typeof parsed?.appId === 'string' ? parsed.appId.trim() : '',
    appSecret: typeof parsed?.appSecret === 'string' ? parsed.appSecret.trim() : '',
    defaultCwd: typeof parsed?.defaultCwd === 'string' ? parsed.defaultCwd.trim() : '',
    provider: normalizeProvider(parsed?.provider),
    model: typeof parsed?.model === 'string' ? parsed.model.trim() : '',
    allowedUserIds: typeof parsed?.allowedUserIds === 'string' ? parsed.allowedUserIds.trim() : '',
    autoStart: parsed?.autoStart === true,
  };
}

export function getDefaultFeishuBridgeConfig(): FeishuBridgeConfig {
  return { ...DEFAULT_CONFIG };
}

export function loadFeishuBridgeConfig(): FeishuBridgeConfig {
  const filePath = CONFIG_PATH();
  if (!existsSync(filePath)) {
    return getDefaultFeishuBridgeConfig();
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<FeishuBridgeConfig>;
    return normalizeConfig(parsed);
  } catch {
    return getDefaultFeishuBridgeConfig();
  }
}

export function saveFeishuBridgeConfig(config: FeishuBridgeConfig): FeishuBridgeConfig {
  const normalized = normalizeConfig(config);
  writeFileSync(CONFIG_PATH(), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}
