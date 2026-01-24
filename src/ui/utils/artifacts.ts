import type { StreamMessage, ContentBlock } from '../types';

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

    for (const block of msg.message.content) {
      if (!isToolUseBlock(block)) continue;
      const sourceTool = normalizeToolName(block.name);
      if (!sourceTool) continue;

      const input = block.input || {};
      const filePath = getFirstString(input, [
        'file_path',
        'path',
        'file',
        'filename',
        'absolute_file_path',
        'absoluteFilePath',
      ]);
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

