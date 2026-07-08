import assert from 'node:assert/strict';
import { mapEditToClass, mergeClassName, applyVariantHint } from '../../src/electron/libs/design-writeback/tailwind-map';
import { locateJsxElement, locateLineByFingerprint } from '../../src/electron/libs/design-writeback/source-locator';
import { computeWritebackPlan } from '../../src/electron/libs/design-writeback/write-plan';
import { applyReversePatch } from '../../src/electron/libs/design-writeback/patch';
import { enqueueFileWrite, drainFileWrites } from '../../src/electron/libs/design-writeback/file-write-queue';

// ── tailwind-map: scale hit, arbitrary fallback, sides ──────────────────────
{
  assert.equal(mapEditToClass('padding', '24px')!.className, 'p-6');
  assert.equal(mapEditToClass('padding', '22px')!.className, 'p-[22px]');
  assert.equal(mapEditToClass('padding-top', '16px')!.className, 'pt-4');
  assert.equal(mapEditToClass('margin-inline', '8px')!.className, 'mx-2');
  assert.equal(mapEditToClass('gap', '12px')!.className, 'gap-3');
  assert.equal(mapEditToClass('width', '64px')!.className, 'w-16');
}

// ── colors are always arbitrary (no palette table) ──────────────────────────
{
  assert.equal(mapEditToClass('color', '#1a2b3c')!.className, 'text-[#1a2b3c]');
  assert.equal(mapEditToClass('background-color', 'rgb(255, 0, 0)')!.className, 'bg-[rgb(255,_0,_0)]');
}

// ── font-size scale declares line-height as expected co-change ──────────────
{
  const scaled = mapEditToClass('font-size', '18px')!;
  assert.equal(scaled.className, 'text-lg');
  assert.deepEqual(scaled.alsoAffects, ['line-height']);
  // Arbitrary font-size ALSO whitelists line-height: it removes the old
  // text-* scale token whose line-height then falls away (review finding).
  const arb = mapEditToClass('font-size', '17px')!;
  assert.equal(arb.className, 'text-[17px]');
  assert.deepEqual(arb.alsoAffects, ['line-height']);
}

// ── font-weight / radius / opacity / unsupported ────────────────────────────
{
  assert.equal(mapEditToClass('font-weight', '600')!.className, 'font-semibold');
  assert.equal(mapEditToClass('border-radius', '8px')!.className, 'rounded-lg');
  assert.equal(mapEditToClass('border-radius', '9999px')!.className, 'rounded-full');
  assert.equal(mapEditToClass('opacity', '0.5')!.className, 'opacity-50');
  assert.equal(mapEditToClass('grid-template-areas', 'x'), null, 'unsupported property → null');
}

// ── mergeClassName removes conflicts via twMerge ─────────────────────────────
{
  const merge = mergeClassName('px-4 py-2 bg-blue-500', 'p-6');
  const tokens = merge.merged.split(/\s+/);
  assert.ok(tokens.includes('p-6'));
  assert.ok(!tokens.includes('px-4'), 'conflicting px-4 removed');
  assert.ok(!tokens.includes('py-2'), 'conflicting py-2 removed');
  assert.ok(tokens.includes('bg-blue-500'), 'unrelated class kept');
}

// ── red-team B4: ambiguous var() arbitrary must survive the merge ───────────
{
  const merge = mergeClassName('text-[var(--brand-color)] font-medium', 'text-lg');
  assert.ok(
    merge.merged.split(/\s+/).includes('text-[var(--brand-color)]'),
    `ambiguous var() token preserved (got "${merge.merged}")`
  );
  assert.ok(merge.merged.split(/\s+/).includes('text-lg'));
  // Typed hints are NOT ambiguous — twMerge handles them correctly, no restore.
  const typed = mergeClassName('text-[color:var(--x)]', 'text-lg');
  assert.ok(typed.merged.includes('text-[color:var(--x)]'));
}

// ── variant hint (red-team C4) ───────────────────────────────────────────────
{
  assert.equal(applyVariantHint('px-6', 'md:'), 'md:px-6');
  assert.equal(applyVariantHint('px-6', 'hover'), 'hover:px-6');
  assert.equal(applyVariantHint('px-6', null), 'px-6');
}

// ── locator: static className, exact edit ────────────────────────────────────
const STATIC_FIXTURE = [
  `export function Card() {`,
  `  return (`,
  `    <div className="card">`,
  `      <button className="px-4 py-2 bg-blue-500">保存</button>`,
  `    </div>`,
  `  );`,
  `}`,
].join('\n');
{
  const plan = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: STATIC_FIXTURE,
    anchor: { line: 4, tagName: 'button', siblingIndex: 0, classNameSnapshot: 'px-4 py-2 bg-blue-500' },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok, `plan ok (${!plan.ok ? plan.detail : ''})`);
  if (plan.ok) {
    assert.equal(plan.strategy, 'static');
    assert.ok(plan.newContent.includes('className="p-6 bg-blue-500"') || plan.newContent.includes('className="bg-blue-500 p-6"'),
      `merged className written (got: ${plan.newContent.split('\n')[3]})`);
    assert.deepEqual(plan.addedClasses, ['p-6']);
    assert.ok(plan.removedClasses.includes('px-4') && plan.removedClasses.includes('py-2'));
    // Untouched parts byte-identical
    assert.ok(plan.newContent.includes('<div className="card">'));
  }
}

// ── red-team B1: same line, two same-tag elements — sibling index decides ────
const SAME_LINE_FIXTURE = `export const X = () => (<div><span className="a">价格</span><span className="b">$99</span></div>);`;
{
  const plan = computeWritebackPlan({
    filePath: 'X.tsx',
    fileContent: SAME_LINE_FIXTURE,
    anchor: { line: 1, tagName: 'span', siblingIndex: 1, classNameSnapshot: 'b' },
    edits: [{ property: 'color', value: '#ff0000' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.ok(plan.newContent.includes('className="a"'), 'first span untouched');
    assert.ok(/className="[^"]*text-\[#ff0000\][^"]*">\$99/.test(plan.newContent), 'second span edited');
  }
}

// ── stale anchors are refused, not guessed ───────────────────────────────────
{
  const outOfRange = computeWritebackPlan({
    filePath: 'X.tsx',
    fileContent: SAME_LINE_FIXTURE,
    anchor: { line: 1, tagName: 'span', siblingIndex: 5, classNameSnapshot: null },
    edits: [{ property: 'color', value: '#ff0000' }],
  });
  assert.ok(!outOfRange.ok && outOfRange.reason === 'stale-anchor');

  const snapshotMismatch = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: STATIC_FIXTURE,
    anchor: { line: 4, tagName: 'button', siblingIndex: 0, classNameSnapshot: 'totally different classes' },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(!snapshotMismatch.ok && snapshotMismatch.reason === 'stale-anchor');

  const wrongLine = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: STATIC_FIXTURE,
    anchor: { line: 2, tagName: 'button', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(!wrongLine.ok && wrongLine.reason === 'not-found');
}

// ── cn() first-arg static: edit the literal ──────────────────────────────────
const CN_FIXTURE = [
  `import { cn } from './utils';`,
  `export function Chip({ active }: { active: boolean }) {`,
  `  return <span className={cn('px-4 text-sm', active && 'ring-2')}>chip</span>;`,
  `}`,
].join('\n');
{
  const plan = computeWritebackPlan({
    filePath: 'Chip.tsx',
    fileContent: CN_FIXTURE,
    anchor: { line: 3, tagName: 'span', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.strategy, 'cn-first-static');
    assert.ok(plan.newContent.includes(`cn('p-6 text-sm', active && 'ring-2')`) ||
      plan.newContent.includes(`cn('text-sm p-6', active && 'ring-2')`),
      `first arg edited in place (got: ${plan.newContent.split('\n')[2]})`);
  }
}

// ── cn() with no static first arg: conservative append ───────────────────────
const CN_DYNAMIC_FIXTURE = `export const B = (p: any) => <button className={cn(p.className)}>go</button>;`;
{
  const plan = computeWritebackPlan({
    filePath: 'B.tsx',
    fileContent: CN_DYNAMIC_FIXTURE,
    anchor: { line: 1, tagName: 'button', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.strategy, 'cn-append');
    assert.ok(plan.newContent.includes(`cn(p.className, "p-6")`), plan.newContent);
  }
}

// ── truly dynamic className: refuse to agent ─────────────────────────────────
const TERNARY_FIXTURE = `export const T = (big: boolean) => <div className={big ? 'p-8' : 'p-2'}>t</div>;`;
{
  const plan = computeWritebackPlan({
    filePath: 'T.tsx',
    fileContent: TERNARY_FIXTURE,
    anchor: { line: 1, tagName: 'div', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(!plan.ok && plan.reason === 'dynamic-classname');
}

// ── no className: insert attribute ───────────────────────────────────────────
const BARE_FIXTURE = `export const Bare = () => <section>\n  <p>text</p>\n</section>;`;
{
  const plan = computeWritebackPlan({
    filePath: 'Bare.tsx',
    fileContent: BARE_FIXTURE,
    anchor: { line: 2, tagName: 'p', siblingIndex: 0, classNameSnapshot: '' },
    edits: [{ property: 'margin-top', value: '16px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.strategy, 'insert-attr');
    assert.ok(plan.newContent.includes('<p className="mt-4">'), plan.newContent);
  }
}

// ── BOM survives round-trip; reverse patch still applies ─────────────────────
{
  const withBom = '\ufeff' + STATIC_FIXTURE;
  const plan = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: withBom,
    anchor: { line: 4, tagName: 'button', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.newContent.charCodeAt(0), 0xfeff, 'BOM preserved');
    const undone = applyReversePatch(plan.newContent, plan.reversePatch);
    assert.ok(undone.ok);
    if (undone.ok) assert.equal(undone.content, withBom, 'BOM round-trip exact');
  }
}

// ── CRLF content untouched outside the edit ──────────────────────────────────
{
  const crlf = STATIC_FIXTURE.replace(/\n/g, '\r\n');
  const plan = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: crlf,
    anchor: { line: 4, tagName: 'button', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.ok(plan.newContent.includes('\r\n'), 'CRLF preserved');
    assert.equal(plan.newContent.split('\r\n').length, crlf.split('\r\n').length, 'no line count change');
  }
}

// ── reverse patch: tolerates third-party edits elsewhere, refuses conflicts ──
{
  const plan = computeWritebackPlan({
    filePath: 'Card.tsx',
    fileContent: STATIC_FIXTURE,
    anchor: { line: 4, tagName: 'button', siblingIndex: 0, classNameSnapshot: null },
    edits: [{ property: 'padding', value: '24px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    // Third-party edit far from ours (red-team A2/C2): rollback must keep it.
    const thirdParty = plan.newContent.replace('export function Card()', 'export default function Card()');
    const undone = applyReversePatch(thirdParty, plan.reversePatch);
    assert.ok(undone.ok, 'rollback applies around unrelated edits');
    if (undone.ok) {
      assert.ok(undone.content.includes('export default function Card()'), 'third-party edit preserved');
      assert.ok(undone.content.includes('px-4 py-2 bg-blue-500'), 'our edit reverted');
    }
    // Conflicting edit inside our region: refuse, never clobber.
    const conflicted = plan.newContent.replace('bg-blue-500', 'bg-red-500');
    const refused = applyReversePatch(conflicted, plan.reversePatch);
    assert.ok(!refused.ok, 'conflicting region refuses rollback');
  }
}

// ── component tags and member expressions locate correctly ───────────────────
{
  const fixture = `export const Y = () => <Card.Header className="p-2">h</Card.Header>;`;
  const plan = computeWritebackPlan({
    filePath: 'Y.tsx',
    fileContent: fixture,
    anchor: { line: 1, tagName: 'Card.Header', siblingIndex: 0, classNameSnapshot: 'p-2' },
    edits: [{ property: 'padding', value: '16px' }],
  });
  assert.ok(plan.ok);
  if (plan.ok) assert.ok(plan.newContent.includes('className="p-4"'));
}

// ── variant hint threads through the whole plan (red-team C4) ────────────────
{
  const fixture = `export const R = () => <div className="px-4 md:px-8">r</div>;`;
  const plan = computeWritebackPlan({
    filePath: 'R.tsx',
    fileContent: fixture,
    anchor: { line: 1, tagName: 'div', siblingIndex: 0, classNameSnapshot: 'px-4 md:px-8' },
    edits: [{ property: 'padding-inline', value: '24px' }],
    variantHint: 'md:',
  });
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.addedClasses, ['md:px-6']);
    const line = plan.newContent;
    assert.ok(line.includes('md:px-6'), line);
    assert.ok(line.includes('px-4'), 'base class untouched when editing the md variant');
    assert.ok(!line.includes('md:px-8'), 'old md variant replaced');
  }
}

// ── fingerprint index space matches locateJsxElement (review finding):
//    a dynamic-className same-tag twin BEFORE the target on the same line ────
{
  const fixture = `export const Z = (c: string) => (<div className={c}><div className="card p-2">inner</div></div>);`;
  const fp = locateLineByFingerprint(fixture, 'div', 'card p-2');
  assert.ok(fp.ok);
  if (fp.ok) {
    assert.equal(fp.siblingIndex, 1, 'index counts ALL same-tag elements, dynamic ones included');
    const plan = computeWritebackPlan({
      filePath: 'Z.tsx',
      fileContent: fixture,
      anchor: { line: fp.line, tagName: 'div', siblingIndex: fp.siblingIndex, classNameSnapshot: 'card p-2' },
      edits: [{ property: 'padding', value: '24px' }],
    });
    assert.ok(plan.ok, `plan ok (${!plan.ok ? plan.detail : ''})`);
    if (plan.ok) {
      assert.ok(plan.newContent.includes('className={c}'), 'outer dynamic div untouched');
      assert.ok(/className="[^"]*p-6[^"]*">inner/.test(plan.newContent), 'inner static div edited');
    }
  }
}

// ── file-write-queue: same path serializes, different paths independent ──────
{
  (async () => {
    const order: string[] = [];
    const slow = enqueueFileWrite('/tmp/a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('a1');
      return 'a1';
    });
    const fast = enqueueFileWrite('/tmp/a', () => {
      order.push('a2');
      return 'a2';
    });
    const other = enqueueFileWrite('/tmp/b', () => {
      order.push('b1');
      return 'b1';
    });
    const [r1, r2, r3] = await Promise.all([slow, fast, other]);
    assert.deepEqual([r1, r2, r3], ['a1', 'a2', 'b1']);
    assert.ok(order.indexOf('a1') < order.indexOf('a2'), 'same-path jobs serialized');
    assert.equal(order[0], 'b1', 'different path did not wait for the slow job');
    // Failure does not wedge the queue.
    await enqueueFileWrite('/tmp/a', () => {
      throw new Error('boom');
    }).catch(() => undefined);
    const after = await enqueueFileWrite('/tmp/a', () => 'recovered');
    assert.equal(after, 'recovered');
    await drainFileWrites();
    console.log('design-writeback.test.ts passed');
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
