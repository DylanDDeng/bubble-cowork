import type { AgentProvider, StreamMessage } from '../types';
import { extractGeneratedMediaFromMessages, extractMarkdownImageSourcesFromMessages, resolveGeneratedMediaPath } from './generated-media';

export interface StudioImage { path: string; turnId: string; createdAt?: number; prompt?: string }
export interface ImageComment { id: string; x: number; y: number; text: string }
export interface BrushStroke { size: number; points: { x: number; y: number }[] }
export const IMAGE_RATIOS = [['Square', '1:1'], ['Portrait', '3:4'], ['Story', '9:16'], ['Landscape', '4:3'], ['Widescreen', '16:9']] as const;
export const supportsImageStudio = (provider?: AgentProvider) => provider === 'codex' || provider === 'grok';
export const clampImageZoom = (zoom: number) => Math.max(10, Math.min(400, zoom));
export function imagePoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }) {
  return { x: Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))), y: Math.max(0, Math.min(1, (y - rect.top) / Math.max(1, rect.height))) };
}

/** Resolve transcript aliases against provider outputs before falling back to cwd. */
function resolveImageReference(path: string, cwd: string | undefined, currentPaths: string[], priorPaths: string[] = []): string | null {
  if (path.startsWith('/')) return path;
  const relative = path.replace(/^\.\//, '');
  const projectPath = resolveGeneratedMediaPath(cwd, relative);
  for (const candidates of [currentPaths, priorPaths]) {
    if (candidates.includes(projectPath)) return projectPath;
    const matches = [...new Set(candidates.filter(candidate => candidate.endsWith(`/${relative}`)))];
    if (matches.length === 1) return matches[0];
    // A short alias must not merge two distinct outputs with the same filename.
    if (matches.length > 1) return null;
  }
  return projectPath;
}

/** Repair a selected entry created by the older cwd-only collector. */
export function resolveStudioActivePath(path: string, images: StudioImage[], cwd?: string): string {
  const paths = images.map(image => image.path);
  const root = cwd?.replace(/\/+$/, '');
  if (!path || paths.includes(path) || !root || !path.startsWith(`${root}/`)) return path;
  return resolveImageReference(path.slice(root.length + 1), cwd, paths) || path;
}

/** Main-thread outputs only. Full paths keep identically named images distinct. */
export function collectStudioImages(messages: StreamMessage[], cwd?: string): StudioImage[] {
  const turns: { id: string; createdAt?: number; messages: StreamMessage[] }[] = [];
  for (const message of messages) {
    if (message.parentToolUseId) continue;
    if (message.type === 'user_prompt' || !turns.length) turns.push({ id: ('uuid' in message && message.uuid) || `turn:${turns.length}`, createdAt: message.createdAt, messages: [] });
    turns.at(-1)!.messages.push(message);
  }
  const seen = new Set<string>();
  return turns.flatMap(turn => {
    const generated = extractGeneratedMediaFromMessages(turn.messages, { identity: 'path' }).filter(item => item.kind === 'image');
    const currentPaths = generated.map(item => item.path).filter(path => path.startsWith('/'));
    const priorPaths = [...seen];
    const markdown = extractMarkdownImageSourcesFromMessages(turn.messages).flatMap(src => {
      let path = src;
      if (src.startsWith('file://')) { try { path = decodeURIComponent(src.slice(7)); } catch { return []; } }
      return !/^(?:https?:|data:|blob:)/i.test(path) && /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path) ? [{ path }] : [];
    });
    return [...generated, ...markdown].flatMap(item => {
      const path = resolveImageReference(item.path, cwd, currentPaths, priorPaths);
      if (!path?.startsWith('/') || seen.has(path)) return [];
      seen.add(path);
      return [{ path, turnId: turn.id, createdAt: turn.createdAt, prompt: 'prompt' in item && typeof item.prompt === 'string' ? item.prompt : undefined }];
    });
  });
}

export function imageCommentPrompt(paths: string[], comments: Record<string, ImageComment[]>, prompt = ''): string {
  const groups = paths.flatMap((path, index) => {
    const notes = comments[path] || [];
    return notes.length ? [`Image ${index + 1}:\n${notes.map((note, n) => `${n + 1}. (x: ${Math.round(note.x * 1000) / 10}%, y: ${Math.round(note.y * 1000) / 10}%) ${note.text}`).join('\n')}`] : [];
  });
  if (prompt.trim()) groups.push(groups.length ? `Additional instructions:\n${prompt.trim()}` : prompt.trim());
  return groups.join('\n\n');
}

export function imageEditEffectivePrompt(provider: 'codex' | 'grok', prompt: string, paths: string[]): string {
  const request = `${prompt}\n\nUse the available image generation/editing skill to edit the supplied image${paths.length > 1 ? 's' : ''}. Produce the edited image output, preserve the originals, and save each result to a new file. Return the resulting local image paths using Markdown image embeds.\n\nReference files (in attachment order):\n${paths.map((path, index) => `${index + 1}. ${path}`).join('\n')}`;
  return provider === 'grok' ? `/imagine ${request}` : request;
}

export function drawBrushStrokes(canvas: HTMLCanvasElement, strokes: BrushStroke[], mask = false) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image selection canvas is unavailable.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (mask) { context.fillStyle = 'black'; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.strokeStyle = context.fillStyle = mask ? 'white' : getComputedStyle(canvas).color;
  context.lineCap = context.lineJoin = 'round';
  for (const stroke of strokes) {
    context.lineWidth = Math.min(canvas.width, canvas.height) * stroke.size / 100;
    const first = stroke.points[0];
    if (!first) continue;
    context.beginPath();
    context.arc(first.x * canvas.width, first.y * canvas.height, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    context.beginPath(); context.moveTo(first.x * canvas.width, first.y * canvas.height);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * canvas.width, point.y * canvas.height);
    context.stroke();
  }
}
