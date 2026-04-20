import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { McpServerConfig } from './claude-settings';

// Codex 的 MCP 配置保存在 ~/.codex/config.toml 的 [mcp_servers.<name>] 段里。
// 为了避免破坏用户原有的 TOML（比如 profiles、providers、注释等），这里不使用
// 完整的 TOML 解析/序列化器，而是只对 [mcp_servers.*] 段做就地替换。
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

function readText(): string {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return '';
    return readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch (error) {
    console.warn('Failed to read ~/.codex/config.toml:', error);
    return '';
  }
}

function writeText(content: string): void {
  try {
    mkdirSync(dirname(CODEX_CONFIG_PATH), { recursive: true });
    writeFileSync(CODEX_CONFIG_PATH, content, 'utf-8');
  } catch (error) {
    console.warn('Failed to write ~/.codex/config.toml:', error);
    throw error;
  }
}

// 匹配类似 [mcp_servers.foo] 的一行段标头；不匹配子表如 [mcp_servers.foo.env]
const SECTION_HEADER_RE = /^\s*\[mcp_servers\.([^\]\s.]+)\]\s*$/;
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
    if (match) {
      const name = match[1];
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

function parseSectionBody(body: string[]): McpServerConfig {
  const config: McpServerConfig = { type: 'stdio' };
  for (const rawLine of body) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = findTopLevelEquals(trimmed);
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/\s*#.*$/, '');
    if (key === 'command') {
      const parsed = parseString(value);
      if (parsed != null) config.command = parsed;
    } else if (key === 'args') {
      const parsed = parseStringArray(value);
      if (parsed) config.args = parsed;
    } else if (key === 'env') {
      const parsed = parseInlineTable(value);
      if (parsed) config.env = parsed;
    }
  }
  return config;
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

function serializeSection(name: string, config: McpServerConfig): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${formatSectionName(name)}]`);
  if (config.command && config.command.trim()) {
    lines.push(`command = "${escapeString(config.command.trim())}"`);
  }
  if (config.args && config.args.length > 0) {
    lines.push(`args = ${serializeArgs(config.args)}`);
  }
  if (config.env && Object.keys(config.env).length > 0) {
    lines.push(`env = ${serializeEnv(config.env)}`);
  }
  return lines.join('\n');
}

// 读取所有 [mcp_servers.*] 段。
export function getCodexMcpServers(): Record<string, McpServerConfig> {
  const text = readText();
  if (!text) return {};
  const lines = splitLines(text);
  const sections = findMcpSections(lines);
  const result: Record<string, McpServerConfig> = {};
  for (const section of sections) {
    result[section.name] = parseSectionBody(section.body);
  }
  return result;
}

// 写回所有 [mcp_servers.*] 段：就地替换，保留其它内容与注释。
export function saveCodexMcpServers(servers: Record<string, McpServerConfig>): void {
  const text = readText();
  const lines = splitLines(text);
  const sections = findMcpSections(lines);

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
      // Codex 只支持 stdio，没有 command 的条目没意义，直接跳过。
      return cfg && (!cfg.type || cfg.type === 'stdio') && typeof cfg.command === 'string' && cfg.command.trim().length > 0;
    })
    .map((name) => serializeSection(name, servers[name]));

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
