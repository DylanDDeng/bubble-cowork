import type { StreamMessage, ContentBlock } from '../types';
import { getMessageContentBlocks } from './message-content';

export type ArtifactKind = 'html' | 'markdown' | 'json' | 'image' | 'pdf' | 'pptx' | 'xlsx';

export type ArtifactSourceTool = 'Write' | 'Edit';

export interface ArtifactItem {
  filePath: string;
  fileName: string;
  kind: ArtifactKind;
  sourceTool: ArtifactSourceTool;
  toolUseId: string;
  content?: string;
  lastSeenIndex: number;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function getFirstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = getString(input[key]);
    if (v) return v;
  }
  return null;
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || filePath;
}

function extFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').split('?')[0]?.split('#')[0] || '';
  const name = normalized.split('/').pop() || normalized;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export function getArtifactKindFromPath(filePath: string): ArtifactKind | null {
  const ext = extFromPath(filePath);
  switch (ext) {
    case '.html':
    case '.htm':
      return 'html';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.json':
      return 'json';
    case '.pdf':
      return 'pdf';
    case '.pptx':
      return 'pptx';
    case '.xlsx':
      return 'xlsx';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
    case '.bmp':
    case '.ico':
      return 'image';
    default:
      return null;
  }
}

export function getArtifactPathFromToolInput(input: Record<string, unknown>): string | null {
  return getFirstString(input, [
    'file_path',
    'path',
    'file',
    'filename',
    'absolute_file_path',
    'absoluteFilePath',
  ]);
}

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_use' } {
  return block.type === 'tool_use';
}

function normalizeToolName(toolName: string): ArtifactSourceTool | null {
  const name = (toolName || '').trim().toLowerCase();
  if (name === 'write') return 'Write';
  if (name === 'edit') return 'Edit';
  return null;
}

export function extractArtifactsFromMessages(messages: StreamMessage[]): ArtifactItem[] {
  const byPath = new Map<string, ArtifactItem>();
  let index = 0;

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;

    for (const block of getMessageContentBlocks(msg)) {
      if (!isToolUseBlock(block)) continue;
      const sourceTool = normalizeToolName(block.name);
      if (!sourceTool) continue;

      const input = block.input || {};
      const filePath = getArtifactPathFromToolInput(input);
      if (!filePath) continue;

      const kind = getArtifactKindFromPath(filePath);
      if (!kind) continue;

      const content =
        sourceTool === 'Write' && (kind === 'html' || kind === 'markdown' || kind === 'json')
          ? getFirstString(input, ['content', 'text', 'data', 'file_content'])
          : null;

      byPath.set(filePath, {
        filePath,
        fileName: fileNameFromPath(filePath),
        kind,
        sourceTool,
        toolUseId: block.id,
        ...(content ? { content } : {}),
        lastSeenIndex: index++,
      });
    }
  }

  return Array.from(byPath.values()).sort((a, b) => b.lastSeenIndex - a.lastSeenIndex);
}

export function extractLatestSuccessfulHtmlArtifact(messages: StreamMessage[]): ArtifactItem | null {
  const successfulToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.type !== 'user') continue;

    for (const block of getMessageContentBlocks(msg)) {
      if (block.type === 'tool_result' && !block.is_error) {
        successfulToolUseIds.add(block.tool_use_id);
      }
    }
  }

  let latest: ArtifactItem | null = null;
  let index = 0;

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;

    for (const block of getMessageContentBlocks(msg)) {
      if (!isToolUseBlock(block)) continue;

      const sourceTool = normalizeToolName(block.name);
      if (!sourceTool || !successfulToolUseIds.has(block.id)) continue;

      const input = block.input || {};
      const filePath = getArtifactPathFromToolInput(input);
      if (!filePath || getArtifactKindFromPath(filePath) !== 'html') continue;

      latest = {
        filePath,
        fileName: fileNameFromPath(filePath),
        kind: 'html',
        sourceTool,
        toolUseId: block.id,
        lastSeenIndex: index++,
      };
    }
  }

  return latest;
}

export function extractLatestSuccessfulHtmlArtifactFromLatestTurn(
  messages: StreamMessage[]
): ArtifactItem | null {
  let latestPromptIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'user_prompt') {
      latestPromptIndex = i;
      break;
    }
  }

  if (latestPromptIndex < 0) {
    return null;
  }

  return extractLatestSuccessfulHtmlArtifact(messages.slice(latestPromptIndex));
}
