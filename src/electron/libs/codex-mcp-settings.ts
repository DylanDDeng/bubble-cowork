import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import type { McpServerConfig } from './claude-settings';
import {
  buildComputerUseMcpOverrideArgs,
  resolveComputerUseClientPath,
  type ComputerUseSpawnPolicy,
} from './codex-computer-use';
import { NODE_REPL_SERVER_NAME } from '../../shared/computer-use';

// Aegis owns a private Codex MCP catalog. The user's ~/.codex/config.toml is
// read exactly once to seed that catalog and is never written. At runtime the
// catalog is supplied to `codex app-server` through `-c` overrides, so Aegis
// does not need to repoint CODEX_HOME merely to isolate MCP configuration.
function userCodexConfigPath(): string {
  return process.env.AEGIS_CODEX_USER_CONFIG_PATH?.trim() || join(homedir(), '.codex', 'config.toml');
}

export function aegisCodexMcpConfigPath(): string {
  const override = process.env.AEGIS_CODEX_MCP_CONFIG_PATH?.trim();
  if (override) return override;
  return join(app.getPath('userData'), 'codex', 'config.toml');
}

function ensurePrivateConfig(): string {
  const targetPath = aegisCodexMcpConfigPath();
  const sourcePath = userCodexConfigPath();
  if (resolve(targetPath) === resolve(sourcePath)) {
    throw new Error('Aegis Codex MCP config must not resolve to the user Codex config path.');
  }
  if (existsSync(targetPath)) return targetPath;

  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const initial = existsSync(sourcePath)
    ? extractMcpCatalogText(readFileSync(sourcePath, 'utf-8'))
    : '';
  try {
    writeFileSync(targetPath, initial, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return targetPath;
}

function readText(): string {
  try {
    return readFileSync(ensurePrivateConfig(), 'utf-8');
  } catch (error) {
    console.warn('Failed to read the Aegis Codex MCP config:', error);
    return '';
  }
}

function writeText(content: string): void {
  try {
    const targetPath = ensurePrivateConfig();
    writeFileSync(targetPath, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    console.warn('Failed to write the Aegis Codex MCP config:', error);
    throw error;
  }
}

// 匹配 [mcp_servers.foo] / [mcp_servers."foo.bar"] 段标头；不匹配
// [mcp_servers.foo.env] 这类子表。
const SECTION_HEADER_RE = /^\s*\[mcp_servers\.(.+)\]\s*$/;
// 任意段标头（包括上面这种）用于定位段结束
const ANY_SECTION_HEADER_RE = /^\s*\[[^\]]+\]\s*$/;

interface ParsedSection {
  name: string;
  // section 整段（含标头到下一段前的所有行，含尾部空行）在原文件里的起止行号
  startLine: number;
  endLine: number; // exclusive
  body: string[]; // 不含标头的原始行
}

function splitLines(text: string): string[] {
  if (!text) return [];
  // 保留换行风格：以 \n 为主，Windows 行尾由 \r 前缀参与 body，写回时统一 \n。
  return text.split('\n');
}

function findMcpSections(lines: string[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(SECTION_HEADER_RE);
    const rawName = match?.[1]?.trim();
    const name = rawName
      ? /^[A-Za-z0-9_-]+$/.test(rawName)
        ? rawName
        : parseString(rawName)
      : null;
    if (match && name != null) {
      const startLine = i;
      let j = i + 1;
      while (j < lines.length && !ANY_SECTION_HEADER_RE.test(lines[j])) {
        j += 1;
      }
      sections.push({
        name,
        startLine,
        endLine: j,
        body: lines.slice(i + 1, j),
      });
      i = j;
    } else {
      i += 1;
    }
  }
  return sections;
}

function extractMcpCatalogText(text: string): string {
  const lines = splitLines(text);
  const blocks = findMcpSections(lines).map((section) =>
    lines.slice(section.startLine, section.endLine).join('\n').trimEnd()
  );
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

// 解析内联 TOML 字符串字面量 "..."，简单支持常见转义。
function parseString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return null;
}

// 解析形如 ["a", "b"] 的字符串数组。暂不支持跨行数组（Codex 的 MCP 配置通常是单行）。
function parseStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const parts: string[] = [];
  let buf = '';
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      buf += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      buf += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) parts.push(buf);
  const result: string[] = [];
  for (const part of parts) {
    const parsed = parseString(part);
    if (parsed == null) return null;
    result.push(parsed);
  }
  return result;
}

// 解析形如 { KEY = "VALUE", OTHER = "..." } 的内联表。
function parseInlineTable(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};
  const entries: string[] = [];
  let buf = '';
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      buf += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      buf += ch;
      continue;
    }
    if (ch === ',') {
      entries.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) entries.push(buf);
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const eq = findTopLevelEquals(entry);
    if (eq < 0) return null;
    const key = entry.slice(0, eq).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const valueRaw = entry.slice(eq + 1);
    const value = parseString(valueRaw);
    if (value == null || !key) return null;
    result[key] = value;
  }
  return result;
}

function findTopLevelEquals(input: string): number {
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      continue;
    }
    if (ch === '=') return i;
  }
  return -1;
}

interface ParsedSectionBody {
  config: McpServerConfig;
  // 不认识的行(bearer_token_env_var、startup_timeout_sec、tool_timeout_sec、
  // 注释等)原样保留,保存时写回,避免任何一次 Save 静默销毁用户手配的字段。
  extraLines: string[];
}

function parseSectionBody(body: string[]): ParsedSectionBody {
  const config: McpServerConfig = {};
  const extraLines: string[] = [];
  for (const rawLine of body) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      extraLines.push(line);
      continue;
    }
    const eq = findTopLevelEquals(trimmed);
    if (eq < 0) {
      extraLines.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/\s*#.*$/, '');
    if (key === 'command') {
      const parsed = parseString(value);
      if (parsed != null) config.command = parsed;
      else extraLines.push(line);
    } else if (key === 'args') {
      const parsed = parseStringArray(value);
      if (parsed) config.args = parsed;
      else extraLines.push(line);
    } else if (key === 'env') {
      const parsed = parseInlineTable(value);
      if (parsed) config.env = parsed;
      else extraLines.push(line);
    } else if (key === 'url') {
      const parsed = parseString(value);
      if (parsed != null) config.url = parsed;
      else extraLines.push(line);
    } else if (key === 'http_headers') {
      const parsed = parseInlineTable(value);
      if (parsed) config.headers = parsed;
      else extraLines.push(line);
    } else if (key === 'enabled') {
      // Codex natively supports `enabled = false` to disable a server.
      if (value === 'true') config.enabled = true;
      else if (value === 'false') config.enabled = false;
      else extraLines.push(line);
    } else {
      extraLines.push(line);
    }
  }
  config.type = config.url ? 'http' : 'stdio';
  return { config, extraLines };
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function serializeArgs(args: string[]): string {
  return `[${args.map((arg) => `"${escapeString(arg)}"`).join(', ')}]`;
}

function serializeEnv(env: Record<string, string>): string {
  const entries = Object.entries(env).map(([key, value]) => `${formatInlineKey(key)} = "${escapeString(value)}"`);
  return `{ ${entries.join(', ')} }`;
}

// TOML 裸键允许 A-Za-z0-9_-，否则要加引号。
function formatInlineKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${escapeString(key)}"`;
}

function formatSectionName(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${escapeString(name)}"`;
}

function serializeSection(name: string, config: McpServerConfig, extraLines: string[] = []): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${formatSectionName(name)}]`);
  if (config.url && config.url.trim()) {
    lines.push(`url = "${escapeString(config.url.trim())}"`);
  } else if (config.command && config.command.trim()) {
    lines.push(`command = "${escapeString(config.command.trim())}"`);
  }
  if (config.args && config.args.length > 0) {
    lines.push(`args = ${serializeArgs(config.args)}`);
  }
  if (config.env && Object.keys(config.env).length > 0) {
    lines.push(`env = ${serializeEnv(config.env)}`);
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    lines.push(`http_headers = ${serializeEnv(config.headers)}`);
  }
  if (typeof config.enabled === 'boolean') {
    lines.push(`enabled = ${config.enabled ? 'true' : 'false'}`);
  }
  lines.push(...extraLines);
  return lines.join('\n');
}

function formatDottedSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `"${escapeString(value)}"`;
}

/**
 * Build an isolated MCP view for one app-server process.
 *
 * Codex config overrides merge tables instead of replacing them, so an empty
 * `mcp_servers={}` alone does not remove entries from the user's read-only
 * config. Explicitly disable every user entry that is absent from Aegis' private
 * catalog, then reconstruct the private entries. This preserves normal Codex
 * auth/session/config behavior while ensuring the MCP editor, Browser Use, and
 * delegate server never write ~/.codex/config.toml.
 */
export function buildCodexMcpConfigOverrideArgs(options?: {
  computerUsePolicy?: ComputerUseSpawnPolicy;
}): string[] {
  const text = readText();
  const sections = findMcpSections(splitLines(text));
  const args = ['-c', 'mcp_servers={}'];
  const privateNames = new Set(sections.map((section) => section.name));

  // A higher-precedence empty table is deep-merged by Codex 0.147+, not
  // treated as a replacement. Disable source-only entries one by one so a
  // server removed in Aegis cannot remain active through ~/.codex/config.toml.
  try {
    const sourcePath = userCodexConfigPath();
    const sourceText = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf-8') : '';
    const sourceSections = findMcpSections(splitLines(sourceText));
    for (const sourceSection of sourceSections) {
      if (privateNames.has(sourceSection.name)) continue;
      const prefix = `mcp_servers.${formatDottedSegment(sourceSection.name)}`;
      args.push('-c', `${prefix}.enabled=false`);
    }
  } catch (error) {
    console.warn('Failed to build Codex MCP disables from the user config:', error);
  }

  for (const section of sections) {
    const { config, extraLines } = parseSectionBody(section.body);
    const hasCommand = typeof config.command === 'string' && config.command.trim().length > 0;
    const hasUrl = typeof config.url === 'string' && config.url.trim().length > 0;
    if (!hasCommand && !hasUrl) continue;

    const prefix = `mcp_servers.${formatDottedSegment(section.name)}`;
    const pushOverride = (key: string, value: string) => {
      args.push('-c', `${prefix}.${key}=${value}`);
    };

    if (hasUrl) pushOverride('url', `"${escapeString(config.url!.trim())}"`);
    else pushOverride('command', `"${escapeString(config.command!.trim())}"`);
    if (config.args && config.args.length > 0) pushOverride('args', serializeArgs(config.args));
    if (config.env && Object.keys(config.env).length > 0) pushOverride('env', serializeEnv(config.env));
    if (config.headers && Object.keys(config.headers).length > 0) {
      pushOverride('http_headers', serializeEnv(config.headers));
    }
    if (typeof config.enabled === 'boolean') {
      pushOverride('enabled', config.enabled ? 'true' : 'false');
    }

    for (const rawLine of extraLines) {
      const line = rawLine.replace(/\r$/, '').replace(/\s*#.*$/, '').trim();
      if (!line || line.startsWith('[')) continue;
      const eq = findTopLevelEquals(line);
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!key || !value) continue;
      pushOverride(key, value);
    }
  }

  args.push(
    ...buildComputerUseMcpOverrideArgs({
      clientPath: resolveComputerUseClientPath(),
      policy: options?.computerUsePolicy ?? 'read-only',
      hasNodeRepl: privateNames.has(NODE_REPL_SERVER_NAME),
    })
  );

  return args;
}

// 读取所有 [mcp_servers.*] 段。
export function getCodexMcpServers(): Record<string, McpServerConfig> {
  const text = readText();
  if (!text) return {};
  const lines = splitLines(text);
  const sections = findMcpSections(lines);
  const result: Record<string, McpServerConfig> = {};
  for (const section of sections) {
    result[section.name] = parseSectionBody(section.body).config;
  }
  return result;
}

// 写回所有 [mcp_servers.*] 段：就地替换，保留其它内容与注释。
// 现有段里 Aegis 不认识的键（bearer_token_env_var、timeout 等）按段名原样带回；
// extrasOverrides 里的段名用给定行替换原样保留的行（程序化写入自己的段用）。
export function saveCodexMcpServers(
  servers: Record<string, McpServerConfig>,
  extrasOverrides?: Record<string, string[]>
): void {
  const text = readText();
  const lines = splitLines(text);
  const sections = findMcpSections(lines);

  const extrasByName = new Map<string, string[]>();
  for (const section of sections) {
    const { extraLines } = parseSectionBody(section.body);
    if (extraLines.length > 0) extrasByName.set(section.name, extraLines);
  }
  for (const [name, extraLines] of Object.entries(extrasOverrides ?? {})) {
    extrasByName.set(name, extraLines);
  }

  // 拿掉全部现有 mcp_servers 段及其紧邻前置空行，得到干净的非 MCP 基础内容。
  const removalRanges: Array<{ start: number; end: number }> = [];
  for (const section of sections) {
    let start = section.startLine;
    while (start > 0 && lines[start - 1].trim() === '') {
      start -= 1;
    }
    let end = section.endLine;
    while (end > 0 && end <= lines.length && (lines[end - 1]?.trim() ?? '') === '') {
      end -= 1;
    }
    end = Math.max(end, section.startLine + 1);
    removalRanges.push({ start, end });
  }

  const keep: string[] = [];
  let cursor = 0;
  const sortedRanges = [...removalRanges].sort((a, b) => a.start - b.start);
  for (const range of sortedRanges) {
    if (cursor < range.start) {
      keep.push(...lines.slice(cursor, range.start));
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < lines.length) {
    keep.push(...lines.slice(cursor));
  }

  // 去掉尾部连续空行，等下自己补。
  while (keep.length > 0 && keep[keep.length - 1].trim() === '') {
    keep.pop();
  }

  const names = Object.keys(servers).sort((a, b) => a.localeCompare(b));
  const newBlocks = names
    .filter((name) => {
      const cfg = servers[name];
      if (!cfg) return false;
      // stdio 条目要有 command,http/sse 条目要有 url;两者都没有才跳过。
      const hasCommand = typeof cfg.command === 'string' && cfg.command.trim().length > 0;
      const hasUrl = typeof cfg.url === 'string' && cfg.url.trim().length > 0;
      return hasCommand || hasUrl;
    })
    .map((name) => serializeSection(name, servers[name], extrasByName.get(name)));

  let output = keep.join('\n');
  if (newBlocks.length > 0) {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n';
    if (output.length > 0) output += '\n';
    output += newBlocks.join('\n\n');
    output += '\n';
  } else if (output.length > 0 && !output.endsWith('\n')) {
    output += '\n';
  }

  writeText(output);
}

// 程序化 upsert 单个条目（比如 Aegis 自己的 delegate server）：其余条目原样
// 保留，本条目的 extras 用给定行整体替换（端口/超时每次启动都要刷新）。
export function upsertCodexMcpServer(
  name: string,
  config: McpServerConfig,
  extraLines: string[] = []
): void {
  const servers = getCodexMcpServers();
  servers[name] = config;
  saveCodexMcpServers(servers, { [name]: extraLines });
}
