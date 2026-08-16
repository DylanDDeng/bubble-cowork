import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { McpServerConfig } from './claude-settings';

// Bubble 的 MCP 配置内嵌在 ~/.bubble/settings.json 的 "mcpServers" 键里（仅全局，
// 无项目级配置）。结构与 Claude 的 mcpServers 基本一致：stdio 用 command/args/env，
// http 用 url/headers。
// 注意：Bubble SDK 的配置校验器要求显式 type 判别字段——无 type 无 command 的
// 条目会以 "unsupported transport type undefined" 被静默丢弃，所以 http/sse 条目
// 必须写回 type。
// settings.json 还包含其它顶层设置，写回时只替换 "mcpServers" 块，其余字段原样保留。
const BUBBLE_SETTINGS_PATH = join(homedir(), '.bubble', 'settings.json');

interface BubbleMcpEntry {
  type?: 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface BubbleSettingsFile {
  mcpServers?: Record<string, BubbleMcpEntry>;
  [key: string]: unknown;
}

function readSettings(configPath: string): BubbleSettingsFile {
  try {
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as BubbleSettingsFile) : {};
  } catch (error) {
    console.warn(`Failed to read Bubble settings at ${configPath}:`, error);
    return {};
  }
}

function writeSettings(configPath: string, config: BubbleSettingsFile): void {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`Failed to write Bubble settings at ${configPath}:`, error);
    throw error;
  }
}

// 读取 settings.json 中的 MCP 服务器，映射到应用内统一的 McpServerConfig。
function readMcpServers(configPath: string): Record<string, McpServerConfig> {
  const config = readSettings(configPath);
  const servers = config.mcpServers || {};
  const result: Record<string, McpServerConfig> = {};

  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') continue;

    if (typeof entry.url === 'string' && entry.url.trim()) {
      const serverConfig: McpServerConfig = { type: 'http', url: entry.url };
      if (entry.headers && Object.keys(entry.headers).length > 0) serverConfig.headers = entry.headers;
      result[name] = serverConfig;
    } else if (typeof entry.command === 'string' && entry.command.trim()) {
      const serverConfig: McpServerConfig = { type: 'stdio', command: entry.command };
      if (Array.isArray(entry.args) && entry.args.length > 0) {
        serverConfig.args = entry.args.filter((part) => typeof part === 'string');
      }
      if (entry.env && Object.keys(entry.env).length > 0) serverConfig.env = entry.env;
      result[name] = serverConfig;
    }
  }

  return result;
}

// 写回 settings.json 的 MCP 服务器：先读整个文件，只替换 "mcpServers" 块再写回，
// settings.json 中的其它顶层设置（模型、主题等）绝不能丢。
function writeMcpServers(configPath: string, servers: Record<string, McpServerConfig>): void {
  const config = readSettings(configPath);
  const next: Record<string, BubbleMcpEntry> = {};

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg) continue;

    if (cfg.type === 'http' || cfg.type === 'sse') {
      if (!cfg.url || !cfg.url.trim()) continue;
      const entry: BubbleMcpEntry = { type: cfg.type, url: cfg.url.trim() };
      if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.headers = cfg.headers;
      next[name] = entry;
    } else {
      if (!cfg.command || !cfg.command.trim()) continue;
      const entry: BubbleMcpEntry = { command: cfg.command.trim() };
      if (cfg.args && cfg.args.length > 0) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
      next[name] = entry;
    }
  }

  config.mcpServers = next;
  writeSettings(configPath, config);
}

// 用户级 MCP 服务器（~/.bubble/settings.json 的 mcpServers 块）
export function getBubbleMcpServers(): Record<string, McpServerConfig> {
  return readMcpServers(BUBBLE_SETTINGS_PATH);
}

export function saveBubbleMcpServers(servers: Record<string, McpServerConfig>): void {
  writeMcpServers(BUBBLE_SETTINGS_PATH, servers);
}
