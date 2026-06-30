// Runtime unit tests for the tree<->legacy adapter and persistence migration.

import assert from 'node:assert/strict';
import {
  deriveLegacyFields,
  deserializeLayout,
  legacyPaneToLeafId,
  migrateLegacyToLayout,
  repairLayout,
  resolveWorkspaceLayout,
} from '../../src/ui/store/layout-adapter';
import {
  allLeaves,
  makeLeaf,
  makeSplit,
  singleLayout,
  splitPane,
  type WorkspaceLayout,
} from '../../src/ui/store/layout-tree';

function serialize(l: WorkspaceLayout): unknown {
  return JSON.parse(JSON.stringify(l));
}

// --- migrate legacy single ------------------------------------------------
{
  const l = migrateLegacyToLayout({ chatLayoutMode: 'single', chatPanes: { primary: { sessionId: 's1' } } });
  assert.equal(l.root.type, 'leaf');
  assert.equal((l.root as any).sessionId, 's1');
}

// --- migrate legacy split -------------------------------------------------
{
  const l = migrateLegacyToLayout({
    chatLayoutMode: 'split',
    activePaneId: 'secondary',
    chatSplitRatio: 0.6,
    chatPanes: { primary: { sessionId: 'sP' }, secondary: { sessionId: 'sS' } },
  });
  assert.equal(l.root.type, 'split');
  if (l.root.type === 'split') {
    assert.deepEqual(l.root.children.map((c) => (c as any).sessionId), ['sP', 'sS']);
    assert.ok(Math.abs(l.root.sizes[0] - 0.6) < 1e-6, 'ratio carried over');
  }
  // active maps to secondary leaf
  const leaves = allLeaves(l.root);
  assert.equal(l.activePaneId, leaves[1].id);
}

// --- migration is idempotent / deterministic across the two seams ---------
{
  const legacy = {
    chatLayoutMode: 'split' as const,
    chatPanes: { primary: { sessionId: 'a' }, secondary: { sessionId: 'b' } },
  };
  const a = migrateLegacyToLayout(legacy);
  const b = migrateLegacyToLayout(legacy);
  assert.deepEqual(serialize(a), serialize(b), 'same legacy input -> identical tree (stable ids)');
}

// --- legacy split with stale secondary (null) collapses to single ---------
{
  const l = migrateLegacyToLayout({
    chatLayoutMode: 'split',
    chatPanes: { primary: { sessionId: 'a' }, secondary: { sessionId: null } },
  });
  assert.equal(l.root.type, 'leaf', 'split without a real secondary session -> single');
}

// --- resolveWorkspaceLayout prefers an already-new blob (identity) --------
{
  const gen = (() => { let i = 0; return () => `x${++i}`; })();
  let live = singleLayout(makeLeaf('A', 'sA'));
  live = splitPane(live, 'A', 'right', 'sB', gen);
  const blob = serialize(live);
  const resolved = resolveWorkspaceLayout({ workspaceLayout: blob });
  assert.deepEqual(serialize(resolved), blob, 'new blob round-trips (ids preserved, no re-mint)');
}

// --- resolveWorkspaceLayout falls back on corrupt blob --------------------
{
  const r1 = resolveWorkspaceLayout({ workspaceLayout: { garbage: true } });
  assert.equal(r1.root.type, 'leaf', 'corrupt new blob -> safe single');
  const r2 = resolveWorkspaceLayout(null);
  assert.equal(r2.root.type, 'leaf', 'null -> safe single');
  const r3 = resolveWorkspaceLayout({});
  assert.equal(r3.root.type, 'leaf', 'empty -> safe single');
}

// --- deserializeLayout rejects duplicate ids ------------------------------
{
  const dup = { root: makeSplit('s', 'row', [makeLeaf('dupe'), makeLeaf('dupe')]), activePaneId: 'dupe', focusOrder: [] };
  const out = deserializeLayout(serialize(dup));
  // second 'dupe' child is dropped -> split degenerates -> collapses to single leaf
  assert.ok(out, 'returns a layout');
  assert.equal(out!.root.type, 'leaf', 'duplicate-id split collapses safely');
}

// --- deriveLegacyFields: single -------------------------------------------
{
  const l = singleLayout(makeLeaf('A', 'sA'));
  const f = deriveLegacyFields(l);
  assert.equal(f.chatLayoutMode, 'single');
  assert.equal(f.savedSplitVisible, false);
  assert.equal(f.activePaneId, 'primary');
  assert.equal(f.chatPanes.primary.sessionId, 'sA');
  assert.equal(f.chatPanes.secondary.sessionId, null);
}

// --- deriveLegacyFields: split, active secondary, ratio -------------------
{
  const gen = (() => { let i = 0; return () => `x${++i}`; })();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen); // active = new (secondary)
  const f = deriveLegacyFields(l);
  assert.equal(f.chatLayoutMode, 'split');
  assert.equal(f.savedSplitVisible, true);
  assert.equal(f.activePaneId, 'secondary');
  assert.equal(f.chatPanes.primary.sessionId, 'sA');
  assert.equal(f.chatPanes.secondary.sessionId, 'sB');
  assert.ok(f.chatSplitRatio >= 0.35 && f.chatSplitRatio <= 0.65, 'ratio clamped to legacy bounds');
}

// --- deriveLegacyFields: N>2 projects first two leaves --------------------
{
  const gen = (() => { let i = 0; return () => `x${++i}`; })();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  const bId = l.activePaneId;
  l = splitPane(l, bId, 'right', 'sC', gen); // [A|B|C]
  const f = deriveLegacyFields(l);
  assert.equal(f.chatPanes.primary.sessionId, 'sA');
  assert.equal(f.chatPanes.secondary.sessionId, 'sB', 'projects first two leaves');
  assert.equal(f.chatLayoutMode, 'split');
}

// --- legacyPaneToLeafId ---------------------------------------------------
{
  const gen = (() => { let i = 0; return () => `x${++i}`; })();
  let l = singleLayout(makeLeaf('A', 'sA'));
  l = splitPane(l, 'A', 'right', 'sB', gen);
  const secondId = allLeaves(l.root)[1].id;
  assert.equal(legacyPaneToLeafId(l, 'primary'), 'A');
  assert.equal(legacyPaneToLeafId(l, 'secondary'), secondId);
}

// --- repairLayout fixes a dangling active id ------------------------------
{
  const l = singleLayout(makeLeaf('A', 'sA'));
  const broken: WorkspaceLayout = { ...l, activePaneId: 'gone', focusOrder: ['gone'] };
  const fixed = repairLayout(broken);
  assert.equal(fixed.activePaneId, 'A');
  assert.deepEqual(fixed.focusOrder, ['A']);
}

console.log('layout-adapter: all unit tests passed');
