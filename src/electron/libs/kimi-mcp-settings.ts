import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { McpServerConfig } from './claude-settings';

// Kimi Code CLI 的 MCP 配置使用标准的 "mcpServers" 结构，与 Claude 的 mcpServers 基本一致：
// stdio 用 command/args/env，http 用 url/headers，不带 type 字段（按是否有 url 推断）。
//   - 用户级：~/.kimi/mcp.json
//   - 项目级：<项目根>/.kimi-code/mcp.json（启动时与用户级合并）
// 这里读写时保留文件中其它未知字段。
const KIMI_GLOBAL_MCP_PATH = join(homedir(), '.kimi', 'mcp.json');

function projectMcpPath(projectPath: string): string {
  return join(projectPath, '.kimi-code', 'mcp.json');
}

interface KimiMcpEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface KimiMcpFile {
  mcpServers?: Record<string, KimiMcpEntry>;
  [key: string]: unknown;
}

function readConfig(configPath: string): KimiMcpFile {
  try {
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as KimiMcpFile) : {};
  } catch (error) {
    console.warn(`Failed to read Kimi MCP config at ${configPath}:`, error);
    return {};
  }
}

function writeConfig(configPath: string, config: KimiMcpFile): void {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`Failed to write Kimi MCP config at ${configPath}:`, error);
    throw error;
  }
}

// 读取指定 mcp.json 的 MCP 服务器，映射到应用内统一的 McpServerConfig。
function readMcpServers(configPath: string): Record<string, McpServerConfig> {
  const config = readConfig(configPath);
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

// 写回指定 mcp.json 的 MCP 服务器：整体替换 "mcpServers" 块，保留文件中其它字段。
function writeMcpServers(configPath: string, servers: Record<string, McpServerConfig>): void {
  const config = readConfig(configPath);
  const next: Record<string, KimiMcpEntry> = {};

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg) continue;

    if (cfg.type === 'http' || cfg.type === 'sse') {
      if (!cfg.url || !cfg.url.trim()) continue;
      const entry: KimiMcpEntry = { url: cfg.url.trim() };
      if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.headers = cfg.headers;
      next[name] = entry;
    } else {
      if (!cfg.command || !cfg.command.trim()) continue;
      const entry: KimiMcpEntry = { command: cfg.command.trim() };
      if (cfg.args && cfg.args.length > 0) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
      next[name] = entry;
    }
  }

  config.mcpServers = next;
  writeConfig(configPath, config);
}

// 用户级 MCP 服务器（~/.kimi/mcp.json）
export function getKimiMcpServers(): Record<string, McpServerConfig> {
  return readMcpServers(KIMI_GLOBAL_MCP_PATH);
}

export function saveKimiMcpServers(servers: Record<string, McpServerConfig>): void {
  writeMcpServers(KIMI_GLOBAL_MCP_PATH, servers);
}

// 项目级 MCP 服务器（<项目根>/.kimi-code/mcp.json）
export function getKimiProjectMcpServers(projectPath: string): Record<string, McpServerConfig> {
  if (!projectPath) return {};
  return readMcpServers(projectMcpPath(projectPath));
}

export function saveKimiProjectMcpServers(projectPath: string, servers: Record<string, McpServerConfig>): void {
  if (!projectPath) return;
  writeMcpServers(projectMcpPath(projectPath), servers);
}
