// Runtime unit tests for the recursive tiling layout tree (pure functions).
// Compiled + executed by scripts/verify-layout-tree.mjs.

import assert from 'node:assert/strict';
import {
  type IdGen,
  type WorkspaceLayout,
  allLeaves,
  clearMissingSessions,
  closePane,
  findLeaf,
  findParent,
  getActiveLeaf,
  isSplit,
  leafCount,
  makeLeaf,
  makeSplit,
  normalizeSizes,
  placeSession,
  resizeSplit,
  setActivePane,
  singleLayout,
  splitPane,
  swapLeaves,
} from '../../src/ui/store/layout-tree';

// Deterministic id generator for reproducible trees.
function counterIdGen(prefix = 'n'): IdGen {
  let i = 0;
  return () => `${prefix}${++i}`;
}

const SUM_EPS = 1e-9;
function assertSizesValid(layout: WorkspaceLayout): void {
  const walk = (node: import('../../src/ui/store/layout-tree').PaneNode): void => {
    if (node.type === 'leaf') return;
    assert.equal(node.sizes.length, node.children.length, 'sizes length == children length');
    assert.ok(node.children.length >= 2, 'split has >= 2 children');
    const sum = node.sizes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `split sizes sum to 1 (got ${sum})`);
    assert.ok(node.sizes.every((s) => s > 0), 'all sizes > 0');
    node.children.forEach(walk);
  };
  walk(layout.root);
}

function assertUniqueIds(layout: WorkspaceLayout): void {
  const ids: string[] = [];
  const walk = (node: import('../../src/ui/store/layout-tree').PaneNode): void => {
    ids.push(node.id);
    if (node.type === 'split') node.children.forEach(walk);
  };
  walk(layout.root);
  assert.equal(new Set(ids).size, ids.length, 'all node ids unique');
}

function assertActiveLeafExists(layout: WorkspaceLayout): void {
  assert.ok(findLeaf(layout.root, layout.activePaneId), 'activePaneId points at a leaf');
}

function invariants(layout: WorkspaceLayout): WorkspaceLayout {
  assertSizesValid(layout);
  assertUniqueIds(layout);
  assertActiveLeafExists(layout);
  return layout;
}

// --- normalizeSizes -------------------------------------------------------
{
  assert.deepEqual(normalizeSizes([1, 1]), [0.5, 0.5]);
  assert.deepEqual(normalizeSizes([2, 2, 4]), [0.25, 0.25, 0.5]);
  // zero / negative / NaN get repaired
  const r = normalizeSizes([0, 0]);
  assert.ok(Math.abs(r[0] - 0.5) < SUM_EPS && Math.abs(r[1] - 0.5) < SUM_EPS, 'all-zero -> even');
  const r2 = normalizeSizes([-1, 3]);
  assert.ok(r2[0] === 0 || r2[0] > 0, 'negative clamped');
  assert.ok(Math.abs(r2.reduce((a, b) => a + b, 0) - 1) < SUM_EPS, 'normalized sum 1');
}

// --- makeSplit guards -----------------------------------------------------
{
  assert.throws(() => makeSplit('s', 'row', [makeLeaf('a')]), />= 2 children/);
  const s = makeSplit('s', 'row', [makeLeaf('a'), makeLeaf('b')]);
  assert.deepEqual(s.sizes, [0.5, 0.5]);
}

// --- splitPane: different orientation wraps (nest) ------------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // row split [A | new(sB)]
  invariants(l);
  assert.equal(l.root.type, 'split');
  if (l.root.type === 'split') {
    assert.equal(l.root.orientation, 'row');
    assert.equal(l.root.children.length, 2);
    assert.equal((l.root.children[0] as any).sessionId, 'sA');
    assert.equal((l.root.children[1] as any).sessionId, 'sB');
  }
  // new leaf is active
  assert.equal(getActiveLeaf(l).sessionId, 'sB');
}

// --- splitPane: SAME orientation coalesces into parent (3 columns) --------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // [A | B]
  const bId = l.activePaneId;
  l = splitPane(l, bId, 'right', 'sC', gen); // expect [A | B | C], NOT [A | [B|C]]
  invariants(l);
  assert.equal(l.root.type, 'split');
  if (l.root.type === 'split') {
    assert.equal(l.root.children.length, 3, 'coalesced into a flat 3-column row');
    assert.deepEqual(
      l.root.children.map((c) => (c as any).sessionId),
      ['sA', 'sB', 'sC']
    );
    // A keeps ~0.5, B and C share the old B slot (~0.25 each)
    const [a, b, c] = l.root.sizes;
    assert.ok(Math.abs(a - 0.5) < 1e-6, 'A keeps its half');
    assert.ok(Math.abs(b - 0.25) < 1e-6 && Math.abs(c - 0.25) < 1e-6, 'B split in half');
  }
}

// --- splitPane: 'left' inserts before ------------------------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'left', 'sLeft', gen); // [new(sLeft) | A]
  if (l.root.type === 'split') {
    assert.deepEqual(l.root.children.map((c) => (c as any).sessionId), ['sLeft', 'sA']);
  }
}

// --- splitPane: orthogonal split nests inside a row ----------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // row [A | B]
  const bId = l.activePaneId;
  l = splitPane(l, bId, 'bottom', 'sD', gen); // B becomes col split [B / D]
  invariants(l);
  if (l.root.type === 'split') {
    assert.equal(l.root.orientation, 'row');
    const right = l.root.children[1];
    assert.equal(right.type, 'split');
    if (right.type === 'split') {
      assert.equal(right.orientation, 'col');
      assert.deepEqual(right.children.map((c) => (c as any).sessionId), ['sB', 'sD']);
    }
  }
}

// --- placeSession: forbids duplicate (vacates prior holder) ---------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // [A:sA | B:sB]
  const bId = l.activePaneId;
  // Put sA into B; A must be vacated.
  l = placeSession(l, bId, 'sA');
  const leaves = allLeaves(l.root);
  const holders = leaves.filter((leaf) => leaf.sessionId === 'sA');
  assert.equal(holders.length, 1, 'session lives in exactly one leaf');
  assert.equal(holders[0].id, bId);
  assert.equal(findLeaf(l.root, 'A')!.sessionId, null, 'old holder vacated');
}

// --- closePane: collapse 2->1 promotes survivor to root ------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // [A | B]
  const bId = l.activePaneId;
  l = closePane(l, bId);
  invariants(l);
  assert.equal(l.root.type, 'leaf');
  assert.equal((l.root as any).sessionId, 'sA');
  assert.equal(l.activePaneId, 'A', 'active falls back to surviving leaf');
}

// --- closePane: 3->2 keeps split, renormalizes sizes ---------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  let bId = l.activePaneId;
  l = splitPane(l, bId, 'right', 'sC', gen); // [A | B | C]
  l = closePane(l, bId); // remove middle -> [A | C]
  invariants(l);
  if (l.root.type === 'split') {
    assert.equal(l.root.children.length, 2);
    assert.deepEqual(l.root.children.map((c) => (c as any).sessionId), ['sA', 'sC']);
  }
}

// --- closePane: FLATTEN survivor into same-orientation grandparent -------
{
  const gen = counterIdGen();
  // Build root row [ X | (col [B / C]) ]  then close one of B/C so the col
  // collapses to a single leaf; promoting it must NOT relevel weirdly.
  // Easier flatten case: root row [A | B]; split B bottom -> col[B/D];
  // split that col's child to create nesting, then close to force flatten.
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // row [A | B]
  const bId = l.activePaneId;
  l = splitPane(l, bId, 'bottom', 'sD', gen); // B -> col [B / D]
  // Now wrap A side: split A right to make row deeper: row [A | A2 | colBD]? No.
  // Instead: split D right -> D becomes row [D | E] nested inside the col.
  const dId = l.activePaneId;
  l = splitPane(l, dId, 'right', 'sE', gen); // col[B / row[D|E]]
  invariants(l);
  // Close B: col split drops to one child (row[D|E]); that survivor is a row,
  // grandparent is the OUTER row -> must flatten row[D|E] into outer row.
  l = closePane(l, bId);
  invariants(l);
  assert.equal(l.root.type, 'split');
  if (l.root.type === 'split') {
    assert.equal(l.root.orientation, 'row');
    // outer row should now be flat [A | D | E], not [A | [D|E]]
    const sessions = l.root.children.map((c) => (c as any).sessionId);
    assert.deepEqual(sessions, ['sA', 'sD', 'sE'], 'survivor row flattened into outer row');
  }
}

// --- closePane: closing the only pane yields one empty leaf --------------
{
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = closePane(l, 'A');
  invariants(l);
  assert.equal(l.root.type, 'leaf');
  assert.equal((l.root as any).sessionId, null, 'never empty tree; pane emptied');
  assert.equal(l.activePaneId, 'A');
}

// --- focusOrder MRU drives active selection on close ---------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // active B
  const bId = l.activePaneId;
  l = splitPane(l, bId, 'right', 'sC', gen); // active C, focus [C, B, A]
  const cId = l.activePaneId;
  l = setActivePane(l, bId); // focus [B, C, A]
  l = setActivePane(l, cId); // focus [C, B, A]
  l = closePane(l, cId); // closing active C -> next is B (MRU)
  invariants(l);
  assert.equal(l.activePaneId, bId, 'MRU focus picks previously-focused pane');
}

// --- resizeSplit clamps + normalizes -------------------------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  const splitId = l.root.id;
  l = resizeSplit(l, splitId, [3, 1]); // -> [0.75, 0.25]
  invariants(l);
  if (l.root.type === 'split') {
    assert.ok(Math.abs(l.root.sizes[0] - 0.75) < 1e-6);
    assert.ok(Math.abs(l.root.sizes[1] - 0.25) < 1e-6);
  }
  // wrong-length sizes ignored
  const before = l;
  l = resizeSplit(l, splitId, [1, 1, 1]);
  assert.equal(l, before, 'mismatched sizes length is a no-op');
}

// --- swapLeaves exchanges payloads, keeps structure ----------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  const bId = l.activePaneId;
  const shapeBefore = JSON.stringify({ t: l.root.type, n: leafCount(l.root) });
  l = swapLeaves(l, 'A', bId);
  assert.equal(findLeaf(l.root, 'A')!.sessionId, 'sB');
  assert.equal(findLeaf(l.root, bId)!.sessionId, 'sA');
  assert.equal(JSON.stringify({ t: l.root.type, n: leafCount(l.root) }), shapeBefore);
}

// --- clearMissingSessions nulls invalid sessions, keeps leaves -----------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  l = clearMissingSessions(l, (s) => s === 'sA'); // sB invalid
  invariants(l);
  assert.equal(findLeaf(l.root, 'A')!.sessionId, 'sA');
  const leaves = allLeaves(l.root);
  assert.ok(leaves.some((leaf) => leaf.sessionId === null), 'invalid session nulled');
  assert.equal(leafCount(l.root), 2, 'leaf kept (becomes empty pane)');
}

// --- getActiveLeaf repairs a dangling activePaneId -----------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  const broken: WorkspaceLayout = { ...l, activePaneId: 'does-not-exist' };
  const leaf = getActiveLeaf(broken);
  assert.ok(leaf, 'never returns null');
  assert.ok(findLeaf(l.root, leaf.id), 'falls back to a real leaf');
}

// --- findParent / isSplit sanity -----------------------------------------
{
  const gen = counterIdGen();
  let l = singleLayout(makeLeaf('A', 'sA'));
  assert.equal(isSplit(l), false);
  l = splitPane(l, 'A', 'bottom', 'sB', gen);
  assert.equal(isSplit(l), true);
  const parent = findParent(l.root, 'A');
  assert.ok(parent && parent.type === 'split' && parent.orientation === 'col');
}

console.log('layout-tree: all unit tests passed');
