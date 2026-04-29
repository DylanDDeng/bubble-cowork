import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ClaudeModelConfig } from '../../shared/types';
import { getEnabledCompatibleProviderConfigs } from './compatible-provider-config';

function canonicalizeClaudeModel(model?: string | null): string | null {
  const normalized = model?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\[1m\]$/i, '');
}

// Claude Code 主配置文件路径
const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');
// 旧配置路径（向后兼容）
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// MCP 服务器配置类型
export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

// Claude Code 主配置结构
interface ClaudeJsonConfig {
  mcpServers?: Record<string, McpServerConfig>;
  hasAvailableSubscription?: boolean;
  oauthAccount?: {
    accountUuid?: string;
    [key: string]: unknown;
  };
  projects?: Record<string, {
    mcpServers?: Record<string, McpServerConfig>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface ClaudeSettings {
  env?: Record<string, string>;
  apiKey?: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

const injectedEnvKeys = new Set<string>();
const ANTHROPIC_ENV_PREFIX = 'ANTHROPIC_';
const OFFICIAL_ANTHROPIC_HOSTS = new Set(['api.anthropic.com']);

function isOfficialAnthropicBaseUrl(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return OFFICIAL_ANTHROPIC_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function hasCustomAnthropicEndpoint(env: Record<string, string | undefined>): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  return Boolean(
    (baseUrl && !isOfficialAnthropicBaseUrl(baseUrl)) ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.ANTHROPIC_BEDROCK_BASE_URL ||
      env.ANTHROPIC_VERTEX_PROJECT_ID ||
      env.ANTHROPIC_VERTEX_REGION
  );
}

export function sanitizeOfficialClaudeEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const next = { ...env };
  const hasOAuthAccount = hasClaudeCodeOAuthAccount();
  const shouldDropApiKey = hasOAuthAccount || hasCustomAnthropicEndpoint(next);

  for (const key of Object.keys(next)) {
    if (!key.startsWith(ANTHROPIC_ENV_PREFIX)) {
      continue;
    }

    if (key === 'ANTHROPIC_API_KEY' && !shouldDropApiKey) {
      continue;
    }

    delete next[key];
  }

  return next;
}

// 加载 ~/.claude.json 配置
export function loadClaudeJson(): ClaudeJsonConfig {
  try {
    if (existsSync(CLAUDE_JSON_PATH)) {
      const content = readFileSync(CLAUDE_JSON_PATH, 'utf-8');
      return JSON.parse(content);
    }
    return {};
  } catch (error) {
    console.warn('Failed to load ~/.claude.json:', error);
    return {};
  }
}

export function hasClaudeCodeOAuthAccount(): boolean {
  const config = loadClaudeJson();
  return Boolean(
    (typeof config.oauthAccount?.accountUuid === 'string' && config.oauthAccount.accountUuid.trim()) ||
      config.oauthAccount ||
      config.hasAvailableSubscription
  );
}

function shouldSuppressSettingsApiKey(): boolean {
  return hasClaudeCodeOAuthAccount() && injectedEnvKeys.has('ANTHROPIC_API_KEY');
}

function shouldUseSettingsApiKey(): boolean {
  if (!hasClaudeCodeOAuthAccount()) {
    return true;
  }

  // A real shell-provided ANTHROPIC_API_KEY is an explicit external-key choice.
  return Boolean(process.env.ANTHROPIC_API_KEY && !injectedEnvKeys.has('ANTHROPIC_API_KEY'));
}

// 加载 Claude Code 配置（旧路径，向后兼容）
export function loadClaudeSettings(): ClaudeSettings {
  let parsed: ClaudeSettings = {};

  try {
    if (existsSync(SETTINGS_PATH)) {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      parsed = JSON.parse(content);
    }
  } catch (error) {
    console.warn('Failed to load Claude settings:', error);
    return {};
  }

  // 注入环境变量（仅当未设置时），且只注入一次避免覆盖运行时更新
  if (parsed?.env) {
    for (const [key, value] of Object.entries(parsed.env)) {
      if (key.startsWith(ANTHROPIC_ENV_PREFIX) && hasClaudeCodeOAuthAccount() && !process.env[key]) {
        continue;
      }
      if (!process.env[key] && !injectedEnvKeys.has(key)) {
        process.env[key] = value;
        injectedEnvKeys.add(key);
      }
    }
  }

  if (shouldSuppressSettingsApiKey()) {
    delete process.env.ANTHROPIC_API_KEY;
    injectedEnvKeys.delete('ANTHROPIC_API_KEY');
  }

  if (
    parsed?.apiKey &&
    shouldUseSettingsApiKey() &&
    !process.env.ANTHROPIC_API_KEY &&
    !injectedEnvKeys.has('ANTHROPIC_API_KEY')
  ) {
    process.env.ANTHROPIC_API_KEY = parsed.apiKey;
    injectedEnvKeys.add('ANTHROPIC_API_KEY');
  }

  return parsed;
}

// 获取 Claude Code 环境变量
export function getClaudeEnv(): Record<string, string> {
  const s = loadClaudeSettings();
  const env = { ...(s.env || {}) };
  if (process.env.ANTHROPIC_API_KEY && !injectedEnvKeys.has('ANTHROPIC_API_KEY')) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (hasClaudeCodeOAuthAccount() && !process.env.ANTHROPIC_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }
  if (!env.ANTHROPIC_API_KEY && s.apiKey && shouldUseSettingsApiKey()) {
    env.ANTHROPIC_API_KEY = s.apiKey;
  }
  return env;
}

// 获取 Claude 配置（包含 API key）
export function getClaudeSettings(): { apiKey?: string } | null {
  const s = loadClaudeSettings();

  // 优先从环境变量获取 API key
  const apiKey = process.env.ANTHROPIC_API_KEY || (shouldUseSettingsApiKey() ? s.apiKey : undefined);

  if (!apiKey) {
    return null;
  }

  return { apiKey };
}

export function getClaudeModelConfig(): ClaudeModelConfig {
  const s = loadClaudeSettings();
  const defaultModel = canonicalizeClaudeModel(s.model);
  const compatibleModels = getEnabledCompatibleProviderConfigs().map((provider) => provider.model);
  const options = Array.from(
    new Set(
      [defaultModel, ...compatibleModels].filter(
        (value): value is string => Boolean(value)
      )
    )
  );

  return { defaultModel, options };
}

// 获取 MCP 服务器配置（合并全局和项目级配置）
export function getMcpServers(projectPath?: string): Record<string, McpServerConfig> {
  const config = loadClaudeJson();

  // 全局 MCP 服务器
  const globalServers = config.mcpServers || {};

  // 项目级 MCP 服务器
  let projectServers: Record<string, McpServerConfig> = {};
  if (projectPath && config.projects?.[projectPath]?.mcpServers) {
    projectServers = config.projects[projectPath].mcpServers!;
  }

  // 合并（项目级优先）
  return { ...globalServers, ...projectServers };
}

// 获取全局 MCP 服务器配置（仅全局）
export function getGlobalMcpServers(): Record<string, McpServerConfig> {
  const config = loadClaudeJson();
  return config.mcpServers || {};
}

// 获取项目级 MCP 服务器配置
export function getProjectMcpServers(projectPath: string): Record<string, McpServerConfig> {
  const config = loadClaudeJson();
  return config.projects?.[projectPath]?.mcpServers || {};
}

// 保存全局 MCP 服务器配置
export function saveMcpServers(servers: Record<string, McpServerConfig>): void {
  const config = loadClaudeJson();
  config.mcpServers = servers;

  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// 保存项目级 MCP 服务器配置
export function saveProjectMcpServers(projectPath: string, servers: Record<string, McpServerConfig>): void {
  const config = loadClaudeJson();

  if (!config.projects) {
    config.projects = {};
  }
  if (!config.projects[projectPath]) {
    config.projects[projectPath] = {};
  }
  config.projects[projectPath].mcpServers = servers;

  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
