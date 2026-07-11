import type { SessionUserPromptSummary, StreamMessage } from './types';

const TEXT_LIMIT = 240;

/**
 * Turn-level index for the chat outline rail: one entry per top-level user
 * prompt, carrying the prompt text, the agent's final reply text of that
 * turn, and the files the turn's tool calls touched. Pure function of the
 * message list so the main process (full history) and the renderer (loaded
 * page, updates live while a turn streams) stay in lockstep.
 */
export function buildSessionUserPromptSummaries(
  messages: StreamMessage[]
): SessionUserPromptSummary[] {
  const summaries: SessionUserPromptSummary[] = [];
  let current: SessionUserPromptSummary | null = null;
  let currentPaths: Set<string> | null = null;

  for (const message of messages) {
    if (message.type === 'user_prompt' && !message.parentToolUseId) {
      if (typeof message.createdAt !== 'number' || !Number.isFinite(message.createdAt)) {
        current = null;
        currentPaths = null;
        continue;
      }
      const text = (message.prompt || '').trim();
      const attachmentNames = (message.attachments || [])
        .map((attachment) => attachment.name)
        .filter(Boolean);
      if (!text && attachmentNames.length === 0) {
        current = null;
        currentPaths = null;
        continue;
      }
      current = {
        createdAt: message.createdAt,
        text: truncate(text),
        attachmentNames,
        replyText: '',
        changedFiles: [],
      };
      currentPaths = new Set();
      summaries.push(current);
      continue;
    }

    if (!current || !currentPaths || message.type !== 'assistant') {
      continue;
    }

    const blocks = getContentBlocks(message.message?.content);

    // Reply preview: the turn's last top-level assistant text. Subagent
    // chatter (parentToolUseId) stays out of the preview.
    if (!message.parentToolUseId) {
      const text = blocks
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        current.replyText = truncate(text);
      }
    }

    // Changed files: mutating tool calls anywhere in the turn, subagents
    // included — their edits are part of what the turn did.
    for (const block of blocks) {
      if (!isToolUseBlock(block)) continue;
      const name = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
      if (!MUTATING_TOOL_NAMES.has(name)) continue;
      const input = isRecord(block.input) ? block.input : {};
      for (const filePath of extractFilePaths(input)) {
        const normalized = filePath.replaceAll('\\', '/');
        if (currentPaths.has(normalized)) continue;
        currentPaths.add(normalized);
        current.changedFiles.push(normalized.split('/').pop() || normalized);
      }
    }
  }

  return summaries;
}

const MUTATING_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'delete',
  'write_file',
  'edit_file',
  'create_file',
  'apply_patch',
]);

const TOOL_USE_BLOCK_TYPES = new Set(['tool_use', 'mcp_tool_use', 'server_tool_use']);

const FILE_PATH_INPUT_KEYS = [
  'file_path',
  'path',
  'file',
  'filename',
  'absolute_file_path',
  'absoluteFilePath',
  'notebook_path',
];

type ToolUseLikeBlock = { type: string; name?: unknown; input?: unknown };

function isToolUseBlock(block: unknown): block is ToolUseLikeBlock {
  return (
    isRecord(block) && typeof block.type === 'string' && TOOL_USE_BLOCK_TYPES.has(block.type)
  );
}

function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of FILE_PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      paths.push(value.trim());
      break;
    }
  }

  // apply_patch style structured input: { changes: { "<path>": {...} } }.
  const changes = isRecord(input.changes) ? input.changes : null;
  if (changes) {
    for (const [originalPath, rawSpec] of Object.entries(changes)) {
      const spec = isRecord(rawSpec) ? rawSpec : {};
      const nextPath =
        firstString(spec, ['move_path', 'new_path', 'path']) || originalPath;
      if (nextPath.trim()) {
        paths.push(nextPath.trim());
      }
    }
  }

  return paths;
}

function getContentBlocks(content: unknown): Array<Record<string, unknown> & { type: string }> {
  if (Array.isArray(content)) {
    return content.filter(
      (block): block is Record<string, unknown> & { type: string } =>
        isRecord(block) && typeof block.type === 'string'
    );
  }
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}
