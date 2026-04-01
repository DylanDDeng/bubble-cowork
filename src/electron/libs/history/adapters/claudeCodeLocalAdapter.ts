import * as path from 'path';
import type { ContentBlock, StreamMessage } from '../../../../shared/types';
import type {
  ClaudeCodeSessionIndexEntry,
  UnifiedSessionRecord,
} from '../types';

function toTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return typeof item === 'string' ? item : '';
        }

        const block = item as { type?: unknown; text?: unknown; tool_name?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          return `Selected tool: ${block.tool_name}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return '';
}

function normalizeContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const normalized: ContentBlock[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const block = item as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      signature?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };

    if (block.type === 'text' && typeof block.text === 'string') {
      normalized.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      normalized.push({
        type: 'thinking',
        thinking: block.thinking,
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
      });
      continue;
    }

    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      normalized.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {},
      });
      continue;
    }

    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      normalized.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: normalizeToolResultContent(block.content),
        ...(block.is_error === true ? { is_error: true } : {}),
      });
    }
  }

  return normalized;
}

function extractPromptText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const block = item as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildClaudeCodeSessionTitle(
  entry: ClaudeCodeSessionIndexEntry | undefined,
  fallbackPrompt: string,
  sessionId: string
): string {
  const preferred = entry?.summary?.trim() || entry?.firstPrompt?.trim() || fallbackPrompt.trim();
  if (!preferred) {
    return `Claude Code ${sessionId.slice(0, 8)}`;
  }

  const singleLine = preferred.replace(/\s+/g, ' ').trim();
  return singleLine.length > 88 ? `${singleLine.slice(0, 85)}...` : singleLine;
}

export function adaptClaudeCodeJsonl(
  raw: string,
  filePath: string,
  entry?: ClaudeCodeSessionIndexEntry
): {
  session: UnifiedSessionRecord;
  messages: StreamMessage[];
} {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sessionId = path.basename(filePath, '.jsonl');
  const messages: StreamMessage[] = [];
  let firstPrompt = '';
  let cwd: string | null = entry?.projectPath?.trim() || null;
  let model: string | null = null;
  let firstTimestamp: number | null = toTimestamp(entry?.created);
  let lastTimestamp: number | null = toTimestamp(entry?.modified);

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const timestamp = typeof event.timestamp === 'string' ? toTimestamp(event.timestamp) : null;
      if (!cwd && typeof event.cwd === 'string' && event.cwd.trim()) {
        cwd = event.cwd;
      }
      if (timestamp !== null) {
        firstTimestamp = firstTimestamp === null ? timestamp : Math.min(firstTimestamp, timestamp);
        lastTimestamp = lastTimestamp === null ? timestamp : Math.max(lastTimestamp, timestamp);
      }

      if (event.type === 'user') {
        const message = event.message as { content?: unknown } | undefined;
        const content = message?.content;
        const promptText = extractPromptText(content);
        const createdAt = timestamp ?? Date.now();

        if (promptText) {
          if (!firstPrompt) {
            firstPrompt = promptText;
          }
          messages.push({
            type: 'user_prompt',
            prompt: promptText,
            createdAt,
          });
          continue;
        }

        const normalized = normalizeContentBlocks(content);
        if (normalized.length > 0) {
          messages.push({
            type: 'user',
            uuid: typeof event.uuid === 'string' ? event.uuid : `external-user-${createdAt}`,
            message: { content: normalized },
            createdAt,
          });
        }
        continue;
      }

      if (event.type === 'assistant') {
        const message = event.message as { content?: unknown; model?: unknown } | undefined;
        const normalized = normalizeContentBlocks(message?.content);
        if (typeof message?.model === 'string' && message.model.trim()) {
          model = message.model;
        }
        if (normalized.length > 0) {
          messages.push({
            type: 'assistant',
            uuid: typeof event.uuid === 'string' ? event.uuid : `external-assistant-${timestamp ?? Date.now()}`,
            message: { content: normalized },
            createdAt: timestamp ?? Date.now(),
          });
        }
        continue;
      }

      if (event.type === 'system' && event.subtype === 'compact_boundary' && typeof event.uuid === 'string') {
        messages.push({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: event.uuid,
          session_id: typeof event.sessionId === 'string' ? event.sessionId : sessionId,
          compactMetadata:
            event.compactMetadata && typeof event.compactMetadata === 'object'
              ? {
                  trigger:
                    (event.compactMetadata as { trigger?: unknown }).trigger === 'auto' ? 'auto' : 'manual',
                  preTokens:
                    typeof (event.compactMetadata as { preTokens?: unknown }).preTokens === 'number'
                      ? (event.compactMetadata as { preTokens: number }).preTokens
                      : 0,
                }
              : { trigger: 'manual', preTokens: 0 },
          createdAt: timestamp ?? Date.now(),
        });
      }
    } catch {
      continue;
    }
  }

  const createdAt = firstTimestamp ?? Date.now();
  const updatedAt = lastTimestamp ?? createdAt;
  const title = buildClaudeCodeSessionTitle(entry, firstPrompt, sessionId);

  return {
    session: {
      id: sessionId,
      title,
      cwd,
      provider: 'claude',
      model,
      source: 'claude_code_local',
      readOnly: true,
      createdAt,
      updatedAt,
      externalFilePath: filePath,
      externalFileMtime: entry?.fileMtime ?? null,
    },
    messages,
  };
}
