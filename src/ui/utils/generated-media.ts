import type { StreamMessage } from '../types';
import {
  extractMediaPathsFromValue,
  getGeneratedMediaKind,
  isMediaGenerationTool,
  mediaKindFromToolName,
  readGeneratedMediaFromToolInput,
  type GeneratedMediaItem,
} from '../../shared/generated-media';
import { getMessageContentBlocks } from './message-content';

export type { GeneratedMediaItem, GeneratedMediaKind } from '../../shared/generated-media';
export { getGeneratedMediaKind, isMediaGenerationTool } from '../../shared/generated-media';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function resolveGeneratedMediaPath(cwd: string | null | undefined, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  const root = (cwd || '').replace(/\/+$/, '');
  return root ? `${root}/${trimmed.replace(/^\.\//, '')}` : trimmed;
}

function mediaIdentity(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function preferMediaItem(current: GeneratedMediaItem | undefined, next: GeneratedMediaItem): GeneratedMediaItem {
  if (!current) return next;
  const currentAbs = current.path.startsWith('/');
  const nextAbs = next.path.startsWith('/');
  if (nextAbs && !currentAbs) return next;
  if (next.path.length > current.path.length) return next;
  return current;
}

export function extractGeneratedMediaFromMessages(messages: StreamMessage[]): GeneratedMediaItem[] {
  const byIdentity = new Map<string, GeneratedMediaItem>();
  const toolMeta = new Map<string, { name: string; prompt?: string }>();

  const addItem = (item: GeneratedMediaItem) => {
    const id = mediaIdentity(item.path);
    byIdentity.set(id, preferMediaItem(byIdentity.get(id), item));
  };

  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      if (block.type !== 'tool_use') continue;
      const prompt = isRecord(block.input) && typeof block.input.prompt === 'string'
        ? block.input.prompt
        : undefined;
      toolMeta.set(block.id, { name: block.name, prompt });
      for (const item of readGeneratedMediaFromToolInput(block.input)) {
        addItem({ ...item, toolUseId: block.id, prompt: item.prompt || prompt });
      }
    }
  }

  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user') continue;
    for (const block of getMessageContentBlocks(message)) {
      if (block.type !== 'tool_result' || block.is_error) continue;
      const meta = toolMeta.get(block.tool_use_id);
      if (!meta || !isMediaGenerationTool(meta.name)) continue;
      for (const item of extractMediaPathsFromValue(block.content, mediaKindFromToolName(meta.name))) {
        addItem({ ...item, toolUseId: block.tool_use_id, prompt: meta.prompt });
      }
    }
  }

  return Array.from(byIdentity.values());
}

export function isGeneratedMediaPath(filePath: string): boolean {
  return getGeneratedMediaKind(filePath) !== null;
}

const MARKDOWN_IMAGE_SRC = /!\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function extractMarkdownImageSources(text: string): string[] {
  const sources: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_SRC)) {
    const src = (match[1] || '').trim();
    if (src) sources.push(src);
  }
  return sources;
}

export function extractMarkdownImageSourcesFromMessages(messages: StreamMessage[]): string[] {
  const sources: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      if (block.type !== 'text' || !block.text) continue;
      sources.push(...extractMarkdownImageSources(block.text));
    }
  }
  return sources;
}

export function findGeneratedMediaForPath(
  requestedPath: string,
  media: GeneratedMediaItem[]
): GeneratedMediaItem | null {
  const requested = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!requested) return null;
  const requestedBase = requested.split('/').pop() || requested;
  return media.find((item) => {
    const path = item.path.replace(/\\/g, '/');
    return path === requested || path.endsWith(`/${requested}`) || path.split('/').pop() === requestedBase;
  }) ?? null;
}

function pathMatchesMarkdownSrc(mediaPath: string, src: string): boolean {
  const normalizedSrc = src.replace(/^\.\//, '').replace(/\\/g, '/');
  const normalizedPath = mediaPath.replace(/\\/g, '/');
  if (normalizedPath === normalizedSrc || normalizedPath.endsWith(`/${normalizedSrc}`)) {
    return true;
  }
  const mediaBase = normalizedPath.split('/').pop() || normalizedPath;
  const srcBase = normalizedSrc.split('/').pop() || normalizedSrc;
  return Boolean(mediaBase) && mediaBase === srcBase;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function embedPathAliases(item: GeneratedMediaItem): string[] {
  const path = item.path.replace(/\\/g, '/');
  const base = path.split('/').pop() || path;
  const nested = path.match(/(?:images|assets|videos)\/[^/]+$/);
  return Array.from(new Set([path, base, nested?.[0]].filter((value): value is string => Boolean(value))));
}

/** Turn `![alt](`path`)` into a real markdown image so it can render or be stripped. */
export function normalizeBacktickMarkdownImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(\s*`([^`]+)`\s*\)/g, '![$1]($2)');
}

/** Remove image embeds that the generated-media gallery already shows. */
export function stripGeneratedMediaEmbeds(text: string, media: GeneratedMediaItem[]): string {
  let result = normalizeBacktickMarkdownImages(text);
  if (media.length === 0) return result;

  const aliases = media.flatMap(embedPathAliases).map(escapeRegExp);
  if (aliases.length === 0) return result;
  const pathGroup = aliases.join('|');
  result = result.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*(?:${pathGroup})\\s*\\)`, 'g'), '');
  result = result.replace(new RegExp(`^[ \\t]*\`?(?:${pathGroup})\`?[ \\t]*$`, 'gm'), '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop gallery tiles that the answer already embeds as markdown images. */
export function excludeMediaShownInMarkdown(
  media: GeneratedMediaItem[],
  markdownSources: string[]
): GeneratedMediaItem[] {
  if (media.length === 0 || markdownSources.length === 0) return media;
  return media.filter((item) => !markdownSources.some((src) => pathMatchesMarkdownSrc(item.path, src)));
}
