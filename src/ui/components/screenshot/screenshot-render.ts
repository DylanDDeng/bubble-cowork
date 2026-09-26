import {
  computeScreenshotLayout,
  intersectScreenshotRects,
  screenshotBackground,
  screenshotBackgroundBlurs,
  type ScreenshotBackground,
  type ScreenshotLayout,
  type ScreenshotRect,
  type ScreenshotStyle,
} from '../../../shared/screenshot';

export interface ScreenshotScene {
  image: ImageBitmap;
  crop: ScreenshotRect | null;
  redactions: ScreenshotRect[];
  style: ScreenshotStyle;
  scaleFactor: number;
  customBackground: ImageBitmap | null;
}

export function sceneSource(scene: Pick<ScreenshotScene, 'image' | 'crop'>): ScreenshotRect {
  return scene.crop ?? { x: 0, y: 0, width: scene.image.width, height: scene.image.height };
}

export function sceneLayout(scene: ScreenshotScene): ScreenshotLayout {
  return computeScreenshotLayout(sceneSource(scene), scene.style, scene.scaleFactor);
}

type Ctx = CanvasRenderingContext2D;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** Cover-fit `source` (or a region of it) into a W×H box, like CSS background-size: cover. */
function drawCover(ctx: Ctx, image: CanvasImageSource & { width: number; height: number }, region: ScreenshotRect | null, width: number, height: number): void {
  const src = region ?? { x: 0, y: 0, width: image.width, height: image.height };
  const scale = Math.max(width / src.width, height / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  ctx.drawImage(image, src.x, src.y, src.width, src.height, (width - w) / 2, (height - h) / 2, w, h);
}

function paintBackgroundLayer(ctx: Ctx, background: ScreenshotBackground, width: number, height: number, scene: ScreenshotScene): void {
  switch (background.kind) {
    case 'solid':
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, width, height);
      return;
    case 'linear': {
      // Same geometry as CSS linear-gradient(<angle>, ...).
      const angle = (background.angle * Math.PI) / 180;
      const dx = Math.sin(angle);
      const dy = -Math.cos(angle);
      const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
      const cx = width / 2;
      const cy = height / 2;
      const gradient = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
      for (const [offset, color] of background.stops) gradient.addColorStop(offset, color);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      return;
    }
    case 'mesh': {
      ctx.fillStyle = background.base;
      ctx.fillRect(0, 0, width, height);
      const size = Math.max(width, height);
      for (const blob of background.blobs) {
        const x = blob.x * width;
        const y = blob.y * height;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, blob.r * size);
        gradient.addColorStop(0, blob.color);
        gradient.addColorStop(1, `${blob.color}00`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }
      return;
    }
    case 'backdrop':
      drawCover(ctx, scene.image, sceneSource(scene), width, height);
      return;
    case 'image':
      if (scene.customBackground) drawCover(ctx, scene.customBackground, null, width, height);
      return;
    case 'none':
      return;
  }
}

function drawBackground(ctx: Ctx, background: ScreenshotBackground, width: number, height: number, blur: number, scene: ScreenshotScene): void {
  if (background.kind === 'none') return;
  if (blur <= 0) {
    paintBackgroundLayer(ctx, background, width, height, scene);
    return;
  }
  const layer = makeCanvas(width, height);
  paintBackgroundLayer(layer.getContext('2d')!, background, width, height, scene);
  // Blur fades toward transparent at the edges; overdraw so the frame stays solid.
  const bleed = blur * 2;
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(layer, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
  ctx.restore();
}

function roundedRect(ctx: Ctx, rect: ScreenshotRect, radius: number): void {
  ctx.beginPath();
  if (radius > 0) ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  else ctx.rect(rect.x, rect.y, rect.width, rect.height);
}

/**
 * Downsample the region to a handful of blocks and scale back up with
 * smoothing. The result reads as a heavy blur but, unlike a Gaussian blur,
 * cannot be sharpened back into legible text.
 */
function drawRedaction(ctx: Ctx, image: ImageBitmap, source: ScreenshotRect, dest: ScreenshotRect, scaleFactor: number): void {
  const block = Math.max(8 * scaleFactor, Math.min(source.width, source.height) / 3);
  const cols = Math.max(1, Math.round(source.width / block));
  const rows = Math.max(1, Math.round(source.height / block));
  const small = makeCanvas(cols, rows);
  const smallCtx = small.getContext('2d')!;
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, cols, rows);
  ctx.save();
  ctx.beginPath();
  ctx.rect(dest.x, dest.y, dest.width, dest.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, cols, rows, dest.x, dest.y, dest.width, dest.height);
  ctx.restore();
}

/**
 * Render the composed screenshot. `zoom` scales the whole output (1 = export
 * resolution); every pixel value is multiplied explicitly instead of using a
 * canvas transform because shadow and filter lengths ignore the transform.
 */
export function renderScreenshotScene(canvas: HTMLCanvasElement, scene: ScreenshotScene, zoom = 1): ScreenshotLayout {
  const source = sceneSource(scene);
  const layout = computeScreenshotLayout(source, scene.style, scene.scaleFactor);
  const z = zoom;
  const width = Math.max(1, Math.round(layout.width * z));
  const height = Math.max(1, Math.round(layout.height * z));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);

  const background = screenshotBackground(scene.style.background);
  const blur = screenshotBackgroundBlurs(background) ? scene.style.blur * scene.scaleFactor * z : 0;
  drawBackground(ctx, background, width, height, blur, scene);

  const dest: ScreenshotRect = {
    x: layout.image.x * z,
    y: layout.image.y * z,
    width: layout.image.width * z,
    height: layout.image.height * z,
  };
  const radius = layout.radius * z;

  const strength = scene.style.shadow / 100;
  if (strength > 0) {
    // Cast the shadow from a shape parked off-canvas so no fill shows through
    // transparent corners of window captures.
    const offset = width + height + 1000;
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${0.12 + 0.28 * strength})`;
    ctx.shadowBlur = 50 * strength * scene.scaleFactor * z;
    ctx.shadowOffsetX = offset;
    ctx.shadowOffsetY = 18 * strength * scene.scaleFactor * z;
    ctx.fillStyle = '#000';
    roundedRect(ctx, { ...dest, x: dest.x - offset }, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundedRect(ctx, dest, radius);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scene.image, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
  for (const redaction of scene.redactions) {
    const visible = intersectScreenshotRects(redaction, source);
    if (!visible) continue;
    drawRedaction(ctx, scene.image, visible, {
      x: dest.x + (visible.x - source.x) * z,
      y: dest.y + (visible.y - source.y) * z,
      width: visible.width * z,
      height: visible.height * z,
    }, scene.scaleFactor);
  }
  ctx.restore();
  return layout;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the screenshot.'))), 'image/png');
  });
}

export async function exportScreenshotPng(scene: ScreenshotScene, options: { maxEdge?: number; maxBytes?: number } = {}): Promise<Uint8Array> {
  const layout = sceneLayout(scene);
  let zoom = options.maxEdge ? Math.min(1, options.maxEdge / Math.max(layout.width, layout.height)) : 1;
  const canvas = makeCanvas(1, 1);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    renderScreenshotScene(canvas, scene, zoom);
    const blob = await canvasToPng(canvas);
    if (!options.maxBytes || blob.size <= options.maxBytes || attempt === 3) {
      return new Uint8Array(await blob.arrayBuffer());
    }
    zoom *= 0.75;
  }
  throw new Error('Could not encode the screenshot.');
}
