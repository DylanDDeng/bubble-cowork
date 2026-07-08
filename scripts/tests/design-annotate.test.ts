import assert from 'node:assert/strict';
import { computeAnnotationCrop, composeAnnotationText } from '../../src/ui/components/browser/design-annotate';

// ── crop math: 2x device scale, padding, exact mapping ───────────────────────
{
  const crop = computeAnnotationCrop(
    { x: 100, y: 200, w: 300, h: 50 },
    { w: 1000, h: 800 },
    { width: 2000, height: 1600 },
    24
  )!;
  assert.ok(crop, 'crop produced');
  assert.equal(crop.sx, (100 - 24) * 2);
  assert.equal(crop.sy, (200 - 24) * 2);
  assert.equal(crop.sw, (300 + 48) * 2);
  assert.equal(crop.sh, (50 + 48) * 2);
}

// ── clamping at image edges (element near top-left / bottom-right) ──────────
{
  const nearOrigin = computeAnnotationCrop(
    { x: 4, y: 4, w: 100, h: 40 },
    { w: 1000, h: 800 },
    { width: 1000, height: 800 },
    24
  )!;
  assert.equal(nearOrigin.sx, 0, 'clamped to left edge');
  assert.equal(nearOrigin.sy, 0, 'clamped to top edge');

  const nearBottomRight = computeAnnotationCrop(
    { x: 900, y: 760, w: 200, h: 100 },
    { w: 1000, h: 800 },
    { width: 1000, height: 800 },
    24
  )!;
  assert.equal(nearBottomRight.sx + nearBottomRight.sw, 1000, 'clamped to right edge');
  assert.equal(nearBottomRight.sy + nearBottomRight.sh, 800, 'clamped to bottom edge');
}

// ── degenerate inputs → null (caller attaches the full screenshot) ──────────
{
  assert.equal(computeAnnotationCrop({ x: 0, y: 0, w: 0, h: 10 }, { w: 1000, h: 800 }, { width: 1000, height: 800 }), null);
  assert.equal(computeAnnotationCrop({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 0 }, { width: 1000, height: 800 }), null);
  assert.equal(computeAnnotationCrop({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 800 }, { width: 0, height: 0 }), null);
  // Whole-viewport element: crop equals the full image → null (no point cropping)
  assert.equal(
    computeAnnotationCrop({ x: 0, y: 0, w: 1000, h: 800 }, { w: 1000, h: 800 }, { width: 1000, height: 800 }),
    null
  );
}

// ── element fully outside the capture → null, not a negative crop ───────────
{
  assert.equal(
    computeAnnotationCrop({ x: 2000, y: 100, w: 50, h: 50 }, { w: 1000, h: 800 }, { width: 1000, height: 800 }),
    null
  );
}

// ── annotation text: note first, full context, tier-A source ─────────────────
{
  const text = composeAnnotationText({
    note: '这里改成两列布局',
    selection: {
      tagName: 'div',
      className: 'card p-6',
      text: 'Card title',
      source: { file: '/proj/src/App.tsx', line: 12, column: 8, tier: 'fiber' },
      chain: ['Card', 'HomePage'],
    },
    pageUrl: 'http://localhost:5199/',
  });
  assert.ok(text.startsWith('这里改成两列布局'), 'user note leads');
  assert.ok(text.includes('<div class="card p-6">'));
  assert.ok(text.includes('/proj/src/App.tsx:12'));
  assert.ok(text.includes('Card > HomePage'));
  assert.ok(text.includes('http://localhost:5199/'));
  assert.ok(text.includes('screenshot attached'));
}

// ── tier C (no source): still fully usable ───────────────────────────────────
{
  const text = composeAnnotationText({
    note: 'make this button bigger',
    selection: { tagName: 'button', className: '', text: 'Go', source: null, chain: [] },
  });
  assert.ok(text.includes('- Element: <button>'));
  assert.ok(text.includes('Source: unknown'), 'source-less selections say so instead of omitting');
  assert.ok(!text.includes('Component chain:'), 'empty chain omitted');
}

console.log('design-annotate.test.ts passed');
