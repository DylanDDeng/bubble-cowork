import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentProvider, WechatMarkdownHtmlGeneratorConfig } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'wechat-html-generator.json');

const DEFAULT_CONFIG: WechatMarkdownHtmlGeneratorConfig = {
  runtime: 'claude',
  providerId: 'claude',
  model: '',
  temperature: 0.2,
};

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

function normalizeRuntime(value: unknown): AgentProvider {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'opencode':
      return value;
    default:
      return DEFAULT_CONFIG.runtime;
  }
}

export function normalizeWechatHtmlGeneratorConfig(
  input?: (Partial<WechatMarkdownHtmlGeneratorConfig> & { mode?: string }) | null,
): WechatMarkdownHtmlGeneratorConfig {
  const runtime = normalizeRuntime(input?.runtime);
  const maxOutputTokens = normalizeMaxOutputTokens(input?.maxOutputTokens);
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  const providerId =
    typeof input?.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : runtime;

  return {
    runtime,
    providerId,
    model,
    temperature: normalizeTemperature(input?.temperature),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

export function loadWechatHtmlGeneratorConfig(): WechatMarkdownHtmlGeneratorConfig {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return normalizeWechatHtmlGeneratorConfig();
  }

  try {
    return normalizeWechatHtmlGeneratorConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
  } catch {
    return normalizeWechatHtmlGeneratorConfig();
  }
}

export function saveWechatHtmlGeneratorConfig(
  config: WechatMarkdownHtmlGeneratorConfig,
): WechatMarkdownHtmlGeneratorConfig {
  const normalized = normalizeWechatHtmlGeneratorConfig(config);
  writeFileSync(CONFIG_PATH(), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}
