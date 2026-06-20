import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { McpServerConfig } from './claude-settings';

// OpenCode 的 MCP 配置写在 opencode.json 的顶层 "mcp" 字段里：
//   - 全局：~/.config/opencode/opencode.json
//   - 项目级：<项目根>/opencode.json
// 这个文件同时还存着 model / provider 等其它设置，所以这里读写时保留未知字段，
// 只就地替换 "mcp" 这一块。
const OPENCODE_GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');

function projectConfigPath(projectPath: string): string {
  return join(projectPath, 'opencode.json');
}

// OpenCode 的本地（stdio）MCP 条目：command 是 [可执行文件, ...参数] 数组。
interface OpencodeLocalMcp {
  type: 'local';
  command: string[];
  enabled?: boolean;
  environment?: Record<string, string>;
}

// OpenCode 的远程（http）MCP 条目。
interface OpencodeRemoteMcp {
  type: 'remote';
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}

type OpencodeMcpEntry = OpencodeLocalMcp | OpencodeRemoteMcp;

interface OpencodeConfigFile {
  mcp?: Record<string, OpencodeMcpEntry>;
  [key: string]: unknown;
}

function readConfig(configPath: string): OpencodeConfigFile {
  try {
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as OpencodeConfigFile) : {};
  } catch (error) {
    console.warn(`Failed to read OpenCode config at ${configPath}:`, error);
    return {};
  }
}

function writeConfig(configPath: string, config: OpencodeConfigFile): void {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`Failed to write OpenCode config at ${configPath}:`, error);
    throw error;
  }
}

// 读取指定 opencode.json 的 MCP 服务器，映射到应用内统一的 McpServerConfig。
function readMcpServers(configPath: string): Record<string, McpServerConfig> {
  const config = readConfig(configPath);
  const mcp = config.mcp || {};
  const result: Record<string, McpServerConfig> = {};

  for (const [name, entry] of Object.entries(mcp)) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'remote') {
      if (typeof entry.url !== 'string' || !entry.url.trim()) continue;
      const serverConfig: McpServerConfig = { type: 'http', url: entry.url };
      if (entry.headers && Object.keys(entry.headers).length > 0) serverConfig.headers = entry.headers;
      result[name] = serverConfig;
    } else {
      // 没有 type 或 type === 'local' 都按本地 stdio 处理。
      const command = Array.isArray(entry.command) ? entry.command.filter((part) => typeof part === 'string') : [];
      const [cmd, ...args] = command;
      if (!cmd) continue;
      const serverConfig: McpServerConfig = { type: 'stdio', command: cmd };
      if (args.length > 0) serverConfig.args = args;
      if (entry.environment && Object.keys(entry.environment).length > 0) serverConfig.env = entry.environment;
      result[name] = serverConfig;
    }
  }

  return result;
}

// 写回指定 opencode.json 的 MCP 服务器：整体替换 "mcp" 块，保留文件中其它字段（model/provider 等）。
function writeMcpServers(configPath: string, servers: Record<string, McpServerConfig>): void {
  const config = readConfig(configPath);
  const existing = config.mcp || {};
  const next: Record<string, OpencodeMcpEntry> = {};

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg) continue;
    const prev = existing[name];
    // 保留用户可能在文件里手动设置的 enabled: false。
    const enabled = prev && typeof prev.enabled === 'boolean' ? prev.enabled : true;

    if (cfg.type === 'http' || cfg.type === 'sse') {
      if (!cfg.url || !cfg.url.trim()) continue;
      const entry: OpencodeRemoteMcp = { type: 'remote', url: cfg.url.trim(), enabled };
      if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.headers = cfg.headers;
      next[name] = entry;
    } else {
      if (!cfg.command || !cfg.command.trim()) continue;
      const entry: OpencodeLocalMcp = {
        type: 'local',
        command: [cfg.command.trim(), ...(cfg.args || [])],
        enabled,
      };
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.environment = cfg.env;
      next[name] = entry;
    }
  }

  if (Object.keys(next).length > 0) {
    config.mcp = next;
  } else {
    delete config.mcp;
  }

  writeConfig(configPath, config);
}

// 全局 MCP 服务器（~/.config/opencode/opencode.json）
export function getOpencodeMcpServers(): Record<string, McpServerConfig> {
  return readMcpServers(OPENCODE_GLOBAL_CONFIG_PATH);
}

export function saveOpencodeMcpServers(servers: Record<string, McpServerConfig>): void {
  writeMcpServers(OPENCODE_GLOBAL_CONFIG_PATH, servers);
}

// 项目级 MCP 服务器（<项目根>/opencode.json）
export function getOpencodeProjectMcpServers(projectPath: string): Record<string, McpServerConfig> {
  if (!projectPath) return {};
  return readMcpServers(projectConfigPath(projectPath));
}

export function saveOpencodeProjectMcpServers(projectPath: string, servers: Record<string, McpServerConfig>): void {
  if (!projectPath) return;
  writeMcpServers(projectConfigPath(projectPath), servers);
}
