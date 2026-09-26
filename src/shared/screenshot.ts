/** Screenshot capture + beautify editor: shared types and pure layout math. */

export const SCREENSHOT_EDITOR_HASH = 'screenshot-editor';

export function isScreenshotEditorHash(hash: string): boolean {
  return hash.replace(/^#\/?/, '') === SCREENSHOT_EDITOR_HASH;
}

export type ScreenshotMode = 'area' | 'window' | 'app';

export type ScreenshotCaptureResult =
  | { status: 'opened' }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'permission-required' }
  | { status: 'error'; message: string };

export interface ScreenshotCaptureInfo {
  id: string;
  mode: ScreenshotMode;
  /** Pixel size of the raw capture. */
  width: number;
  height: number;
  /** Device pixels per point of the captured display (2 on Retina). */
  scaleFactor: number;
  capturedAt: number;
}

export interface ScreenshotEditorPayload {
  info: ScreenshotCaptureInfo;
  data: Uint8Array;
}

export type ScreenshotExportAction = 'copy' | 'save' | 'attach';

export interface ScreenshotExportResult {
  ok: boolean;
  message?: string;
}

export interface ScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert the renderer's CSS selection to capturePage's window points. */
export function screenshotCaptureRect(
  rect: ScreenshotRect | null,
  bounds: { width: number; height: number },
  zoomFactor: number
): ScreenshotRect | null {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, zoomFactor].every(Number.isFinite)
    || rect.width < 2 || rect.height < 2 || zoomFactor <= 0) return null;
  const clipped = screenshotRectFromPoints(
    { x: rect.x * zoomFactor, y: rect.y * zoomFactor },
    { x: (rect.x + rect.width) * zoomFactor, y: (rect.y + rect.height) * zoomFactor },
    { x: 0, y: 0, width: bounds.width, height: bounds.height }
  );
  return clipped.width > 0 && clipped.height > 0 ? clipped : null;
}

export type ScreenshotBackground =
  | { id: string; label: string; kind: 'none' }
  | { id: string; label: string; kind: 'solid'; color: string }
  | { id: string; label: string; kind: 'linear'; angle: number; stops: ReadonlyArray<readonly [number, string]> }
  | { id: string; label: string; kind: 'mesh'; base: string; blobs: ReadonlyArray<{ x: number; y: number; r: number; color: string }> }
  /** The capture itself, cover-fitted behind the shot. */
  | { id: string; label: string; kind: 'backdrop' }
  /** A user-picked image; the pixels live in editor memory only. */
  | { id: string; label: string; kind: 'image' };

export const SCREENSHOT_BACKGROUNDS: readonly ScreenshotBackground[] = [
  { id: 'none', label: 'None', kind: 'none' },
  {
    id: 'aurora', label: 'Aurora', kind: 'mesh', base: '#1b1f3b', blobs: [
      { x: 0.2, y: 0.25, r: 0.55, color: '#f7a072' },
      { x: 0.8, y: 0.2, r: 0.6, color: '#6c8cff' },
      { x: 0.7, y: 0.85, r: 0.6, color: '#b36bff' },
      { x: 0.15, y: 0.9, r: 0.5, color: '#2ec4b6' },
    ],
  },
  { id: 'backdrop', label: 'Backdrop', kind: 'backdrop' },
  { id: 'sky', label: 'Sky', kind: 'linear', angle: 135, stops: [[0, '#a1c4fd'], [1, '#c2e9fb']] },
  { id: 'peach', label: 'Peach', kind: 'linear', angle: 135, stops: [[0, '#fbc2eb'], [1, '#a6c1ee']] },
  { id: 'indigo', label: 'Indigo', kind: 'linear', angle: 135, stops: [[0, '#667eea'], [1, '#764ba2']] },
  { id: 'dusk', label: 'Dusk', kind: 'linear', angle: 135, stops: [[0, '#ff9a8b'], [0.55, '#ff6a88'], [1, '#ff99ac']] },
  { id: 'mint', label: 'Mint', kind: 'linear', angle: 135, stops: [[0, '#43e97b'], [1, '#38f9d7']] },
  { id: 'graphite', label: 'Graphite', kind: 'linear', angle: 135, stops: [[0, '#434343'], [1, '#0f0f0f']] },
  { id: 'white', label: 'White', kind: 'solid', color: '#ffffff' },
];

export const SCREENSHOT_CUSTOM_BACKGROUND: ScreenshotBackground = { id: 'custom', label: 'Custom image', kind: 'image' };

export const SCREENSHOT_RATIOS = ['auto', '16:9', '4:3', '1:1', '9:16'] as const;
export type ScreenshotRatio = (typeof SCREENSHOT_RATIOS)[number];

export interface ScreenshotStyle {
  background: string;
  blur: number;
  padding: number;
  radius: number;
  shadow: number;
  ratio: ScreenshotRatio;
}

export const SCREENSHOT_STYLE_LIMITS = {
  blur: [0, 40],
  padding: [0, 160],
  radius: [0, 40],
  shadow: [0, 100],
} as const;

export const DEFAULT_SCREENSHOT_STYLE: ScreenshotStyle = {
  background: 'aurora',
  blur: 18,
  padding: 56,
  radius: 12,
  shadow: 40,
  ratio: 'auto',
};

export function screenshotBackground(id: string): ScreenshotBackground {
  if (id === SCREENSHOT_CUSTOM_BACKGROUND.id) return SCREENSHOT_CUSTOM_BACKGROUND;
  return SCREENSHOT_BACKGROUNDS.find((background) => background.id === id) ?? SCREENSHOT_BACKGROUNDS[0];
}

/** Blur only means something on backgrounds with image detail. */
export function screenshotBackgroundBlurs(background: ScreenshotBackground): boolean {
  return background.kind === 'mesh' || background.kind === 'backdrop' || background.kind === 'image';
}

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

/** Persisted styles come from localStorage; never trust their shape. */
export function normalizeScreenshotStyle(value: unknown): ScreenshotStyle {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const background = typeof raw.background === 'string' && SCREENSHOT_BACKGROUNDS.some((item) => item.id === raw.background)
    ? raw.background
    : DEFAULT_SCREENSHOT_STYLE.background;
  const ratio = SCREENSHOT_RATIOS.includes(raw.ratio as ScreenshotRatio) ? (raw.ratio as ScreenshotRatio) : DEFAULT_SCREENSHOT_STYLE.ratio;
  return {
    background,
    blur: clampNumber(raw.blur, SCREENSHOT_STYLE_LIMITS.blur, DEFAULT_SCREENSHOT_STYLE.blur),
    padding: clampNumber(raw.padding, SCREENSHOT_STYLE_LIMITS.padding, DEFAULT_SCREENSHOT_STYLE.padding),
    radius: clampNumber(raw.radius, SCREENSHOT_STYLE_LIMITS.radius, DEFAULT_SCREENSHOT_STYLE.radius),
    shadow: clampNumber(raw.shadow, SCREENSHOT_STYLE_LIMITS.shadow, DEFAULT_SCREENSHOT_STYLE.shadow),
    ratio,
  };
}

export function screenshotRatioValue(ratio: ScreenshotRatio): number | null {
  if (ratio === 'auto') return null;
  const [w, h] = ratio.split(':').map(Number);
  return w / h;
}

export interface ScreenshotLayout {
  /** Output canvas size in pixels. */
  width: number;
  height: number;
  /** Where the (cropped) capture lands inside the output, in pixels. */
  image: ScreenshotRect;
  /** Style values converted from points to output pixels. */
  padding: number;
  radius: number;
}

/**
 * Style values are in points so a Retina and a non-Retina capture look the
 * same; `scaleFactor` converts them to the capture's pixel density.
 */
export function computeScreenshotLayout(
  source: { width: number; height: number },
  style: Pick<ScreenshotStyle, 'padding' | 'radius' | 'ratio'>,
  scaleFactor: number
): ScreenshotLayout {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const padding = Math.round(style.padding * scale);
  const imageWidth = Math.max(1, Math.round(source.width));
  const imageHeight = Math.max(1, Math.round(source.height));
  let width = imageWidth + padding * 2;
  let height = imageHeight + padding * 2;
  const ratio = screenshotRatioValue(style.ratio);
  if (ratio) {
    // Grow the short side only; the shot is never scaled down to fit a ratio.
    if (width / height > ratio) height = Math.round(width / ratio);
    else width = Math.round(height * ratio);
  }
  const radius = Math.min(Math.round(style.radius * scale), Math.floor(Math.min(imageWidth, imageHeight) / 2));
  return {
    width,
    height,
    image: {
      x: Math.round((width - imageWidth) / 2),
      y: Math.round((height - imageHeight) / 2),
      width: imageWidth,
      height: imageHeight,
    },
    padding,
    radius,
  };
}

/** Normalize a drag between two points into a rect clamped to the bounds. */
export function screenshotRectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: ScreenshotRect
): ScreenshotRect {
  const clampX = (x: number) => Math.min(bounds.x + bounds.width, Math.max(bounds.x, x));
  const clampY = (y: number) => Math.min(bounds.y + bounds.height, Math.max(bounds.y, y));
  const x1 = clampX(Math.min(a.x, b.x));
  const y1 = clampY(Math.min(a.y, b.y));
  const x2 = clampX(Math.max(a.x, b.x));
  const y2 = clampY(Math.max(a.y, b.y));
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

export function intersectScreenshotRects(a: ScreenshotRect, b: ScreenshotRect): ScreenshotRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Local-time file name in the same shape macOS uses for screenshots. */
export function screenshotFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Screenshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.png`;
}
