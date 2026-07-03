// Recursive tiling layout tree for the chat workspace.
//
// Replaces the fixed two-pane (primary | secondary, left/right) model with a
// recursive split tree: a node is either a `leaf` (one chat/terminal pane) or a
// `split` (row|col orientation + per-child fractional `sizes` + children).
//
// Everything here is PURE and immutable: each operation returns a new
// WorkspaceLayout without mutating its input, so it is trivially unit-testable
// and safe to drop into a zustand reducer. ID minting is injected via `IdGen`
// so tests can be deterministic.
//
// Invariants enforced:
//  - a split always has >= 2 children and `sizes.length === children.length`,
//    all sizes > 0 and summing to ~1 (constructed through `makeSplit`).
//  - `activePaneId` always points at an existing leaf (`getActiveLeaf` repairs).
//  - the tree never becomes empty: closing the last pane yields one empty leaf.
//  - a given non-null `sessionId` lives in at most one leaf (`placeSession`
//    vacates any prior holder).
//  - splitting/closing coalesces same-orientation neighbours (i3/sway style) so
//    flat layouts stay flat instead of accreting redundant nesting.

export type PaneId = string;
export type SplitOrientation = 'row' | 'col';
export type PaneSurface = 'chat' | 'terminal';
export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

export interface LeafNode {
  type: 'leaf';
  id: PaneId;
  sessionId: string | null;
  surface: PaneSurface;
}

export interface SplitNode {
  type: 'split';
  id: PaneId;
  orientation: SplitOrientation;
  sizes: number[];
  children: PaneNode[];
}

export type PaneNode = LeafNode | SplitNode;

export interface WorkspaceLayout {
  root: PaneNode;
  activePaneId: PaneId;
  /** MRU stack of leaf ids; head is most-recently-focused. Used to pick the
   *  next active pane when the focused one is closed. */
  focusOrder: PaneId[];
}

export type IdGen = () => PaneId;

let __fallbackCounter = 0;
export const defaultIdGen: IdGen = () => {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    __fallbackCounter += 1;
    return `pane-${__fallbackCounter}`;
  }
};

export function edgeOrientation(edge: SplitEdge): SplitOrientation {
  return edge === 'left' || edge === 'right' ? 'row' : 'col';
}

function edgeIsBefore(edge: SplitEdge): boolean {
  return edge === 'left' || edge === 'top';
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function makeLeaf(
  id: PaneId,
  sessionId: string | null = null,
  surface: PaneSurface = 'chat'
): LeafNode {
  return { type: 'leaf', id, sessionId, surface };
}

/** Normalize a sizes array to all-positive fractions summing to 1. */
export function normalizeSizes(sizes: number[]): number[] {
  if (sizes.length === 0) return sizes;
  const safe = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (sum <= 0) return sizes.map(() => 1 / sizes.length);
  return safe.map((s) => s / sum);
}

export function makeSplit(
  id: PaneId,
  orientation: SplitOrientation,
  children: PaneNode[],
  sizes?: number[]
): SplitNode {
  if (children.length < 2) {
    throw new Error('makeSplit requires >= 2 children');
  }
  const raw =
    sizes && sizes.length === children.length
      ? sizes
      : children.map(() => 1 / children.length);
  return { type: 'split', id, orientation, sizes: normalizeSizes(raw), children };
}

export function singleLayout(leaf: LeafNode): WorkspaceLayout {
  return { root: leaf, activePaneId: leaf.id, focusOrder: [leaf.id] };
}

export function emptyLayout(idGen: IdGen = defaultIdGen): WorkspaceLayout {
  return singleLayout(makeLeaf(idGen()));
}

// ---------------------------------------------------------------------------
// Traversal (pure reads)
// ---------------------------------------------------------------------------

export function findNode(node: PaneNode, id: PaneId): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findLeaf(node: PaneNode, id: PaneId): LeafNode | null {
  const found = findNode(node, id);
  return found && found.type === 'leaf' ? found : null;
}

export function findParent(node: PaneNode, childId: PaneId): SplitNode | null {
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    if (child.id === childId) return node;
    const found = findParent(child, childId);
    if (found) return found;
  }
  return null;
}

export function firstLeaf(node: PaneNode): LeafNode {
  let current: PaneNode = node;
  while (current.type === 'split') current = current.children[0];
  return current;
}

export function allLeaves(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(allLeaves);
}

export function leafCount(node: PaneNode): number {
  return allLeaves(node).length;
}

export function isSplit(layout: WorkspaceLayout): boolean {
  return layout.root.type === 'split';
}

export function getActiveLeaf(layout: WorkspaceLayout): LeafNode {
  return findLeaf(layout.root, layout.activePaneId) ?? firstLeaf(layout.root);
}

export function activeSessionId(layout: WorkspaceLayout): string | null {
  return getActiveLeaf(layout).sessionId;
}

/** Map every leaf through `fn`, returning a new tree (structure preserved). */
export function mapLeaves(node: PaneNode, fn: (leaf: LeafNode) => LeafNode): PaneNode {
  if (node.type === 'leaf') return fn(node);
  return { ...node, children: node.children.map((child) => mapLeaves(child, fn)) };
}

function replaceNode(node: PaneNode, targetId: PaneId, replacement: PaneNode): PaneNode {
  if (node.id === targetId) return replacement;
  if (node.type === 'leaf') return node;
  return {
    ...node,
    children: node.children.map((child) => replaceNode(child, targetId, replacement)),
  };
}

// ---------------------------------------------------------------------------
// Focus bookkeeping
// ---------------------------------------------------------------------------

function bumpFocus(order: PaneId[], id: PaneId): PaneId[] {
  return [id, ...order.filter((existing) => existing !== id)];
}

function reselectActive(root: PaneNode, prevActive: PaneId, focusOrder: PaneId[]): WorkspaceLayout {
  const validIds = new Set(allLeaves(root).map((leaf) => leaf.id));
  const prunedFocus = focusOrder.filter((id) => validIds.has(id));
  let activePaneId = prevActive;
  if (!validIds.has(activePaneId)) {
    activePaneId = prunedFocus.find((id) => validIds.has(id)) ?? firstLeaf(root).id;
  }
  return { root, activePaneId, focusOrder: bumpFocus(prunedFocus, activePaneId) };
}

// ---------------------------------------------------------------------------
// Mutations (return new layout)
// ---------------------------------------------------------------------------

export function setActivePane(layout: WorkspaceLayout, leafId: PaneId): WorkspaceLayout {
  if (!findLeaf(layout.root, leafId)) return layout;
  return { ...layout, activePaneId: leafId, focusOrder: bumpFocus(layout.focusOrder, leafId) };
}

export function setPaneSurface(
  layout: WorkspaceLayout,
  leafId: PaneId,
  surface: PaneSurface
): WorkspaceLayout {
  if (!findLeaf(layout.root, leafId)) return layout;
  const root = mapLeaves(layout.root, (leaf) =>
    leaf.id === leafId ? { ...leaf, surface } : leaf
  );
  return { ...layout, root };
}

/**
 * Load `sessionId` into `leafId`, focusing it. Forbids duplicates: any other
 * leaf currently holding the same non-null session is vacated (left empty).
 */
export function placeSession(
  layout: WorkspaceLayout,
  leafId: PaneId,
  sessionId: string | null
): WorkspaceLayout {
  if (!findLeaf(layout.root, leafId)) return layout;
  const root = mapLeaves(layout.root, (leaf) => {
    if (leaf.id === leafId) {
      // Placing content resets the leaf to a chat pane; terminal placements
      // call setPaneSurface('terminal') afterwards.
      return leaf.sessionId === sessionId && leaf.surface === 'chat'
        ? leaf
        : { ...leaf, sessionId, surface: 'chat' as const };
    }
    if (sessionId !== null && leaf.sessionId === sessionId) {
      return { ...leaf, sessionId: null };
    }
    return leaf;
  });
  return { ...layout, root, activePaneId: leafId, focusOrder: bumpFocus(layout.focusOrder, leafId) };
}

/**
 * Split `targetLeafId` along `edge`, putting `sessionId` in the new leaf.
 * Coalesces into the parent split when the orientation matches (i3/sway), so
 * `[A|B]` split-right on B yields `[A|B|C]`, not `[A|[B|C]]`.
 */
export function splitPane(
  layout: WorkspaceLayout,
  targetLeafId: PaneId,
  edge: SplitEdge,
  sessionId: string | null,
  idGen: IdGen = defaultIdGen
): WorkspaceLayout {
  const target = findLeaf(layout.root, targetLeafId);
  if (!target) return layout;

  const orientation = edgeOrientation(edge);
  const before = edgeIsBefore(edge);
  const newLeaf = makeLeaf(idGen());
  const parent = findParent(layout.root, targetLeafId);

  let root: PaneNode;
  if (parent && parent.orientation === orientation) {
    const i = parent.children.findIndex((child) => child.id === targetLeafId);
    const insertAt = before ? i : i + 1;
    const half = parent.sizes[i] / 2;
    const children = [...parent.children];
    const sizes = [...parent.sizes];
    sizes[i] = half;
    children.splice(insertAt, 0, newLeaf);
    sizes.splice(insertAt, 0, half);
    const merged: SplitNode = { ...parent, children, sizes: normalizeSizes(sizes) };
    root = replaceNode(layout.root, parent.id, merged);
  } else {
    const wrap = makeSplit(
      idGen(),
      orientation,
      before ? [newLeaf, target] : [target, newLeaf],
      [0.5, 0.5]
    );
    root = replaceNode(layout.root, targetLeafId, wrap);
  }

  let next: WorkspaceLayout = {
    ...layout,
    root,
    activePaneId: newLeaf.id,
    focusOrder: bumpFocus(layout.focusOrder, newLeaf.id),
  };
  if (sessionId !== null) next = placeSession(next, newLeaf.id, sessionId);
  return next;
}

/**
 * Close `leafId`, collapsing the tree. A parent dropping to one child promotes
 * the survivor; if the survivor is a split with the same orientation as the
 * grandparent, it is flattened into the grandparent (inverse of split-merge).
 * Closing the only pane leaves a single empty leaf (never an empty tree).
 */
export function closePane(layout: WorkspaceLayout, leafId: PaneId): WorkspaceLayout {
  const target = findLeaf(layout.root, leafId);
  if (!target) return layout;

  if (layout.root.type === 'leaf') {
    // Only pane: empty it in place rather than deleting (never empty tree).
    if (layout.root.id !== leafId) return layout;
    const root = makeLeaf(layout.root.id);
    return { root, activePaneId: root.id, focusOrder: [root.id] };
  }

  const parent = findParent(layout.root, leafId)!;
  const i = parent.children.findIndex((child) => child.id === leafId);
  const children = [...parent.children];
  const sizes = [...parent.sizes];
  children.splice(i, 1);
  sizes.splice(i, 1);

  let root: PaneNode;
  if (children.length >= 2) {
    const nextParent: SplitNode = { ...parent, children, sizes: normalizeSizes(sizes) };
    root = replaceNode(layout.root, parent.id, nextParent);
  } else {
    const survivor = children[0];
    if (parent.id === layout.root.id) {
      root = survivor;
    } else {
      const grandparent = findParent(layout.root, parent.id)!;
      const j = grandparent.children.findIndex((child) => child.id === parent.id);
      if (survivor.type === 'split' && survivor.orientation === grandparent.orientation) {
        const weight = grandparent.sizes[j];
        const gpChildren = [...grandparent.children];
        const gpSizes = [...grandparent.sizes];
        gpChildren.splice(j, 1, ...survivor.children);
        gpSizes.splice(j, 1, ...survivor.sizes.map((s) => s * weight));
        const nextGp: SplitNode = {
          ...grandparent,
          children: gpChildren,
          sizes: normalizeSizes(gpSizes),
        };
        root = replaceNode(layout.root, grandparent.id, nextGp);
      } else {
        // Promote survivor in place; grandparent's size slot for `parent` is kept.
        root = replaceNode(layout.root, parent.id, survivor);
      }
    }
  }

  return reselectActive(root, layout.activePaneId, layout.focusOrder);
}

export function resizeSplit(
  layout: WorkspaceLayout,
  splitId: PaneId,
  sizes: number[]
): WorkspaceLayout {
  const node = findNode(layout.root, splitId);
  if (!node || node.type !== 'split' || sizes.length !== node.children.length) {
    return layout;
  }
  const root = replaceNode(layout.root, splitId, { ...node, sizes: normalizeSizes(sizes) });
  return { ...layout, root };
}

/** Exchange the payloads (session + surface) of two leaves; structure intact. */
export function swapLeaves(layout: WorkspaceLayout, aId: PaneId, bId: PaneId): WorkspaceLayout {
  if (aId === bId) return layout;
  const a = findLeaf(layout.root, aId);
  const b = findLeaf(layout.root, bId);
  if (!a || !b) return layout;
  const root = mapLeaves(layout.root, (leaf) => {
    if (leaf.id === aId) return { ...leaf, sessionId: b.sessionId, surface: b.surface };
    if (leaf.id === bId) return { ...leaf, sessionId: a.sessionId, surface: a.surface };
    return leaf;
  });
  return { ...layout, root };
}

/**
 * Relocate an existing leaf's content beside another leaf. The moving leaf is
 * detached (its old spot collapses) and a new pane is created at the target
 * edge carrying the moved session/surface. (Leaf id is not preserved; revisit
 * for terminal pty survival when terminals become tree leaves.)
 */
export function movePane(
  layout: WorkspaceLayout,
  leafId: PaneId,
  targetLeafId: PaneId,
  edge: SplitEdge,
  idGen: IdGen = defaultIdGen
): WorkspaceLayout {
  if (leafId === targetLeafId) return layout;
  const moving = findLeaf(layout.root, leafId);
  const target = findLeaf(layout.root, targetLeafId);
  if (!moving || !target) return layout;

  const removed = closePane(layout, leafId);
  if (!findLeaf(removed.root, targetLeafId)) return layout; // target vanished (shouldn't)
  let next = splitPane(removed, targetLeafId, edge, null, idGen);
  const newLeafId = next.activePaneId;
  next = {
    ...next,
    root: mapLeaves(next.root, (leaf) =>
      leaf.id === newLeafId
        ? { ...leaf, sessionId: moving.sessionId, surface: moving.surface }
        : leaf
    ),
  };
  return next;
}

/** Null out any leaf holding a session that is no longer valid. Leaves stay.
 * Terminal leaves hold PTY thread ids, not chat session ids — the session
 * reconcilers must not vacate them. */
export function clearMissingSessions(
  layout: WorkspaceLayout,
  isValid: (sessionId: string) => boolean
): WorkspaceLayout {
  const root = mapLeaves(layout.root, (leaf) =>
    leaf.surface !== 'terminal' && leaf.sessionId !== null && !isValid(leaf.sessionId)
      ? { ...leaf, sessionId: null }
      : leaf
  );
  return { ...layout, root };
}
