export type GeneratedMediaKind = 'image' | 'video';

export interface GeneratedMediaItem {
  path: string;
  kind: GeneratedMediaKind;
  toolUseId?: string;
  prompt?: string;
}

const MEDIA_EXTENSIONS: Record<string, GeneratedMediaKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
};

const MEDIA_TOOL_NAMES = new Set([
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
]);

const GENERATED_MEDIA_INPUT_KEY = '__aegisGeneratedMedia';

const ABSOLUTE_MEDIA_PATH =
  /(?:^|[\s"'`=(])(\/(?:[^/\s"'`)]|\/)+?\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov))\b/gi;
const RELATIVE_MEDIA_PATH =
  /\b((?:images|assets|videos)\/[^\s"'`]+\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov))\b/gi;
const FILE_URI_MEDIA =
  /file:\/\/(\/(?:[^/\s"'`)]|\/)+?\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov))\b/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function extensionOf(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

export function getGeneratedMediaKind(filePath: string): GeneratedMediaKind | null {
  return MEDIA_EXTENSIONS[extensionOf(filePath)] ?? null;
}

export function isMediaGenerationTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().replace(/^\/+/, '');
  if (MEDIA_TOOL_NAMES.has(normalized)) return true;
  return (
    normalized === 'imagine' ||
    normalized === 'imagine-video' ||
    normalized.includes('image_gen') ||
    normalized.includes('image_edit') ||
    normalized.includes('image_to_video') ||
    normalized.includes('reference_to_video')
  );
}

export function mediaKindFromToolName(toolName: string): GeneratedMediaKind | null {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.includes('video')) return 'video';
  if (isMediaGenerationTool(toolName)) return 'image';
  return null;
}

function pushMediaPath(target: GeneratedMediaItem[], rawPath: string, fallbackKind?: GeneratedMediaKind | null) {
  const path = rawPath.replace(/^['"]|['"]$/g, '').trim();
  if (!path) return;
  const kind = getGeneratedMediaKind(path) ?? fallbackKind;
  if (!kind) return;
  if (target.some((item) => item.path === path || item.path.endsWith(`/${path}`))) return;
  const coveredIndex = target.findIndex((item) => path.endsWith(`/${item.path}`));
  if (coveredIndex >= 0) {
    target[coveredIndex] = { ...target[coveredIndex], path, kind };
    return;
  }
  target.push({ path, kind });
}

export function extractMediaPathsFromValue(
  value: unknown,
  fallbackKind?: GeneratedMediaKind | null
): GeneratedMediaItem[] {
  const found: GeneratedMediaItem[] = [];

  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      for (const match of node.matchAll(FILE_URI_MEDIA)) {
        pushMediaPath(found, decodeURIComponent(match[1] || ''), fallbackKind);
      }
      for (const match of node.matchAll(ABSOLUTE_MEDIA_PATH)) {
        pushMediaPath(found, match[1] || '', fallbackKind);
      }
      for (const match of node.matchAll(RELATIVE_MEDIA_PATH)) {
        pushMediaPath(found, match[1] || '', fallbackKind);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (lower === 'path' || lower === 'file' || lower === 'file_path' || lower === 'filepath'
        || lower === 'uri' || lower === 'url' || lower === 'output' || lower === 'saved_path'
        || lower === 'savedpath' || lower === 'image' || lower === 'video') {
        if (typeof child === 'string') {
          const cleaned = child.startsWith('file://')
            ? decodeURIComponent(child.replace(/^file:\/\//, ''))
            : child;
          pushMediaPath(found, cleaned, fallbackKind);
        }
      }
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return found;
}

export function readGeneratedMediaFromToolInput(
  input: Record<string, unknown> | undefined
): GeneratedMediaItem[] {
  const raw = input?.[GENERATED_MEDIA_INPUT_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== 'string') return [];
    const kind = item.kind === 'video' || item.kind === 'image'
      ? item.kind
      : getGeneratedMediaKind(item.path);
    return kind ? [{ path: item.path, kind, prompt: typeof item.prompt === 'string' ? item.prompt : undefined }] : [];
  });
}

export function withGeneratedMediaInput(
  input: Record<string, unknown>,
  media: GeneratedMediaItem[]
): Record<string, unknown> {
  if (media.length === 0) return input;
  return {
    ...input,
    [GENERATED_MEDIA_INPUT_KEY]: media.map(({ path, kind, prompt }) => ({
      path,
      kind,
      ...(prompt ? { prompt } : {}),
    })),
  };
}
