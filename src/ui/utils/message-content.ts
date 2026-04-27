import type { ContentBlock, StreamMessage } from '../types';

function isContentBlock(value: unknown): value is ContentBlock {
  return !!value && typeof value === 'object' && 'type' in value;
}

export function getContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    return content.filter(isContentBlock);
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    return [{ type: 'text', text: content }];
  }

  return [];
}

export function getMessageContentBlocks(message: StreamMessage): ContentBlock[] {
  if (message.type !== 'assistant' && message.type !== 'user') {
    return [];
  }

  return getContentBlocks(message.message.content);
}

// ── Tool-use / tool-result block normalization ──────────────────────────────
// Claude Agent SDK / Beta Messages API emits more block variants than the
// vanilla {tool_use, tool_result} pair: mcp_tool_use, server_tool_use, plus a
// family of *_tool_result blocks for hosted/server-handled tools. The UI was
// originally written against `tool_use` only, which silently dropped MCP and
// server tool calls — a Claude turn that used MCP would render no trace at all.
// These helpers normalize every variant into the base {id, name, input} /
// {tool_use_id, content, is_error} shape so the rest of the pipeline can stay
// provider-agnostic.

const TOOL_USE_BLOCK_TYPES = new Set<string>([
  'tool_use',
  'mcp_tool_use',
  'server_tool_use',
]);

const TOOL_RESULT_BLOCK_TYPES = new Set<string>([
  'tool_result',
  'mcp_tool_result',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
]);

export interface NormalizedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Original block type, kept so callers can label MCP/server origins. */
  originType: string;
  /** MCP server name when originType === 'mcp_tool_use'. */
  serverName?: string;
}

export interface NormalizedToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  originType: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(content);
  }
}

export function normalizeToolUseBlock(block: unknown): NormalizedToolUseBlock | null {
  if (!isObject(block)) return null;
  const type = block.type;
  if (typeof type !== 'string' || !TOOL_USE_BLOCK_TYPES.has(type)) return null;
  const id = typeof block.id === 'string' ? block.id : '';
  const name = typeof block.name === 'string' ? block.name : '';
  const input = isObject(block.input) ? block.input : {};
  if (!id || !name) return null;
  return {
    type: 'tool_use',
    id,
    name,
    input,
    originType: type,
    serverName: typeof block.server_name === 'string' ? block.server_name : undefined,
  };
}

export function normalizeToolResultBlock(block: unknown): NormalizedToolResultBlock | null {
  if (!isObject(block)) return null;
  const type = block.type;
  if (typeof type !== 'string' || !TOOL_RESULT_BLOCK_TYPES.has(type)) return null;
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!toolUseId) return null;
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: stringifyResultContent(block.content),
    is_error: block.is_error === true,
    originType: type,
  };
}

export function isAnyToolUseBlockType(blockType: string | undefined): boolean {
  return typeof blockType === 'string' && TOOL_USE_BLOCK_TYPES.has(blockType);
}

export function isAnyToolResultBlockType(blockType: string | undefined): boolean {
  return typeof blockType === 'string' && TOOL_RESULT_BLOCK_TYPES.has(blockType);
}
