import assert from 'node:assert/strict';
import {
  DEFAULT_SCREENSHOT_STYLE,
  computeScreenshotLayout,
  intersectScreenshotRects,
  isScreenshotEditorHash,
  normalizeScreenshotStyle,
  screenshotBackground,
  screenshotBackgroundBlurs,
  screenshotFileName,
  screenshotRectFromPoints,
  screenshotCaptureRect,
} from '../../src/shared/screenshot';

// Padding and radius are points: a Retina capture doubles them in pixels.
const retina = computeScreenshotLayout({ width: 1000, height: 600 }, { padding: 50, radius: 12, ratio: 'auto' }, 2);
assert.deepEqual(retina, { width: 1200, height: 800, image: { x: 100, y: 100, width: 1000, height: 600 }, padding: 100, radius: 24 });
const standard = computeScreenshotLayout({ width: 1000, height: 600 }, { padding: 50, radius: 12, ratio: 'auto' }, 1);
assert.equal(standard.width, 1100);
assert.equal(standard.radius, 12);

// Ratios only grow the short side and keep the shot centered.
const wide = computeScreenshotLayout({ width: 800, height: 800 }, { padding: 0, radius: 0, ratio: '16:9' }, 1);
assert.equal(wide.height, 800);
assert.equal(wide.width, Math.round(800 * 16 / 9));
assert.equal(wide.image.x, Math.round((wide.width - 800) / 2));
const square = computeScreenshotLayout({ width: 1600, height: 900 }, { padding: 0, radius: 0, ratio: '1:1' }, 1);
assert.deepEqual([square.width, square.height, square.image.y], [1600, 1600, 350]);
const tall = computeScreenshotLayout({ width: 900, height: 900 }, { padding: 0, radius: 0, ratio: '9:16' }, 1);
assert.equal(tall.height, 1600);

// Radius never exceeds half the short edge.
assert.equal(computeScreenshotLayout({ width: 40, height: 20 }, { padding: 0, radius: 40, ratio: 'auto' }, 2).radius, 10);

// Persisted styles are clamped and unknown/custom backgrounds fall back.
assert.deepEqual(normalizeScreenshotStyle(null), DEFAULT_SCREENSHOT_STYLE);
assert.deepEqual(
  normalizeScreenshotStyle({ background: 'custom', blur: 999, padding: -4, radius: 'x', shadow: 33.6, ratio: '3:2' }),
  { ...DEFAULT_SCREENSHOT_STYLE, blur: 40, padding: 0, shadow: 34 }
);
assert.equal(normalizeScreenshotStyle({ background: 'mint' }).background, 'mint');

assert.equal(screenshotBackgroundBlurs(screenshotBackground('aurora')), true);
assert.equal(screenshotBackgroundBlurs(screenshotBackground('backdrop')), true);
assert.equal(screenshotBackgroundBlurs(screenshotBackground('sky')), false);
assert.equal(screenshotBackground('custom').kind, 'image');
assert.equal(screenshotBackground('missing').id, 'none');

// Drags in any direction normalize and clamp to the image.
const bounds = { x: 0, y: 0, width: 100, height: 50 };
assert.deepEqual(screenshotRectFromPoints({ x: 80, y: 40 }, { x: 20, y: 10 }, bounds), { x: 20, y: 10, width: 60, height: 30 });
assert.deepEqual(screenshotRectFromPoints({ x: -10, y: -10 }, { x: 150, y: 90 }, bounds), bounds);
assert.deepEqual(intersectScreenshotRects({ x: 90, y: 40, width: 30, height: 30 }, bounds), { x: 90, y: 40, width: 10, height: 10 });
assert.equal(intersectScreenshotRects({ x: 100, y: 0, width: 10, height: 10 }, bounds), null);

assert.deepEqual(screenshotCaptureRect({ x: 10, y: 5, width: 20, height: 10 }, bounds, 1.5), { x: 15, y: 8, width: 30, height: 15 });
const contentBounds = { x: 578, y: 417, width: 900, height: 528 };
assert.deepEqual(screenshotCaptureRect({ x: 220, y: 80, width: 560, height: 350 }, contentBounds, 1), { x: 220, y: 80, width: 560, height: 350 }, 'window screen position must not offset a content-relative selection');
assert.deepEqual(screenshotCaptureRect({ x: -10, y: -10, width: 200, height: 100 }, bounds, 2), bounds);
assert.equal(screenshotCaptureRect(null, bounds, 1), null);
assert.equal(screenshotCaptureRect({ x: 0, y: 0, width: 1, height: 10 }, bounds, 1), null);
assert.equal(screenshotCaptureRect({ x: NaN, y: 0, width: 20, height: 10 }, bounds, 1), null);
assert.equal(screenshotCaptureRect({ x: 200, y: 0, width: 20, height: 10 }, bounds, 1), null);

assert.equal(screenshotFileName(new Date(2026, 8, 22, 14, 3, 7)), 'Screenshot 2026-09-22 at 14.03.07.png');
assert.ok(isScreenshotEditorHash('#screenshot-editor'));
assert.ok(isScreenshotEditorHash('#/screenshot-editor'));
assert.ok(!isScreenshotEditorHash('#computer-use-preview'));

console.log('Screenshot layout, style normalization and rect helpers passed');
