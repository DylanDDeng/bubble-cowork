import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
  projects?: Record<string, {
    mcpServers?: Record<string, McpServerConfig>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface ClaudeSettings {
  env?: Record<string, string>;
  apiKey?: string;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

let settings: ClaudeSettings | null = null;
let claudeJsonConfig: ClaudeJsonConfig | null = null;

// 加载 ~/.claude.json 配置
function loadClaudeJson(): ClaudeJsonConfig {
  if (claudeJsonConfig !== null) {
    return claudeJsonConfig;
  }

  try {
    if (existsSync(CLAUDE_JSON_PATH)) {
      const content = readFileSync(CLAUDE_JSON_PATH, 'utf-8');
      claudeJsonConfig = JSON.parse(content);
    } else {
      claudeJsonConfig = {};
    }
  } catch (error) {
    console.warn('Failed to load ~/.claude.json:', error);
    claudeJsonConfig = {};
  }

  return claudeJsonConfig!;
}

// 加载 Claude Code 配置（旧路径，向后兼容）
export function loadClaudeSettings(): ClaudeSettings {
  if (settings !== null) {
    return settings;
  }

  try {
    if (existsSync(SETTINGS_PATH)) {
      const content = readFileSync(SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);

      // 注入环境变量（仅当未设置时）
      if (settings?.env) {
        for (const [key, value] of Object.entries(settings.env)) {
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }

      if (settings?.apiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = settings.apiKey;
      }
    } else {
      settings = {};
    }
  } catch (error) {
    console.warn('Failed to load Claude settings:', error);
    settings = {};
  }

  return settings!;
}

// 获取 Claude Code 环境变量
export function getClaudeEnv(): Record<string, string> {
  const s = loadClaudeSettings();
  return s.env || {};
}

// 获取 Claude 配置（包含 API key）
export function getClaudeSettings(): { apiKey?: string } | null {
  const s = loadClaudeSettings();

  // 优先从环境变量获取 API key
  const apiKey = process.env.ANTHROPIC_API_KEY || s.apiKey;

  if (!apiKey) {
    return null;
  }

  return { apiKey };
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

  // 保存配置
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), 'utf-8');

  // 更新缓存
  claudeJsonConfig = config;
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

  // 保存配置
  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), 'utf-8');

  // 更新缓存
  claudeJsonConfig = config;
}

// 重新加载配置（用于外部修改后刷新）
export function reloadClaudeSettings(): ClaudeSettings {
  settings = null;
  claudeJsonConfig = null;
  return loadClaudeSettings();
}
