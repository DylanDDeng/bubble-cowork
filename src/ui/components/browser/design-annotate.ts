// Pure logic for design-mode annotations: crop math for the element
// screenshot and the composer text block. Kept free of DOM/canvas so both
// are unit-testable; the thin canvas glue lives in DesignDrawer.
import type { DesignSelectionInfo } from '../../../shared/design-mode-types';

export interface AnnotationCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Map an element's viewport-CSS rect onto the captured image (device pixels)
 * with breathing-room padding, clamped to the image. Returns null when the
 * inputs cannot produce a meaningful crop (degenerate rect / mismatched
 * capture) — callers then attach the full screenshot instead.
 */
export function computeAnnotationCrop(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  image: { width: number; height: number },
  paddingCssPx = 24
): AnnotationCrop | null {
  if (rect.w <= 0 || rect.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return null;
  if (image.width <= 0 || image.height <= 0) return null;
  const scale = image.width / viewport.w;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const sx = Math.max(0, Math.floor((rect.x - paddingCssPx) * scale));
  const sy = Math.max(0, Math.floor((rect.y - paddingCssPx) * scale));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.w + paddingCssPx) * scale));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.h + paddingCssPx) * scale));
  const sw = right - sx;
  const sh = bottom - sy;
  if (sw <= 0 || sh <= 0) return null;
  // A crop that IS the whole image adds nothing — signal "no crop needed".
  if (sx === 0 && sy === 0 && sw === image.width && sh === image.height) return null;
  return { sx, sy, sw, sh };
}

/**
 * The text block injected into the composer alongside the cropped
 * screenshot. Leads with the user's own words; element context follows so
 * the agent can act without re-asking. Works for source-less selections too
 * (tier C — React 19 / non-React pages).
 */
export function composeAnnotationText(options: {
  note: string;
  selection: Pick<DesignSelectionInfo, 'tagName' | 'className' | 'text' | 'source' | 'chain'>;
  pageUrl?: string | null;
  /** Only claim a screenshot when one is actually attached — capture is best-effort. */
  hasScreenshot?: boolean;
}): string {
  const { note, selection, pageUrl, hasScreenshot = true } = options;
  const lines: string[] = [];
  lines.push(note.trim());
  lines.push('');
  lines.push(hasScreenshot ? 'Annotated element (screenshot attached):' : 'Annotated element (no screenshot available):');
  const descriptor = selection.className
    ? `<${selection.tagName} class="${selection.className.slice(0, 200)}">`
    : `<${selection.tagName}>`;
  lines.push(`- Element: ${descriptor}`);
  if (selection.text) lines.push(`- Text: "${selection.text.slice(0, 120)}"`);
  if (selection.source) {
    lines.push(`- Source: ${selection.source.file}:${selection.source.line}`);
  } else {
    lines.push('- Source: unknown (no dev source map for this element — locate it by the context above)');
  }
  if (selection.chain.length > 0) lines.push(`- Component chain: ${selection.chain.join(' > ')}`);
  if (pageUrl) lines.push(`- Page: ${pageUrl}`);
  return lines.join('\n');
}
