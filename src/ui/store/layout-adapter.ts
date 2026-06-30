// Adapter between the recursive tiling tree (source of truth) and the legacy
// two-pane fields (primary/secondary) that existing UI still reads, plus the
// persistence migration. All pure + unit-tested so the risky derivation and
// migration logic is exercised without a running app.

import {
  type LeafNode,
  type PaneNode,
  type SplitNode,
  type WorkspaceLayout,
  allLeaves,
  findLeaf,
  firstLeaf,
  isSplit,
  makeLeaf,
  makeSplit,
  normalizeSizes,
  singleLayout,
} from './layout-tree';

export const WORKSPACE_LAYOUT_SCHEMA_VERSION = 1;

// Deterministic ids for migrated panes so the two startup seams (module init +
// persist merge) produce the SAME tree from the same legacy blob (no UUID
// divergence), and re-migration is idempotent.
const MIGRATED_PRIMARY_ID = 'legacy-primary';
const MIGRATED_SECONDARY_ID = 'legacy-secondary';

export const SPLIT_RATIO_MIN = 0.35;
export const SPLIT_RATIO_MAX = 0.65;
export const SPLIT_RATIO_DEFAULT = 0.5;

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

// ---- Legacy shapes (mirror the existing UiResumeState pane fields) ----------

export interface LegacyPaneState {
  id: 'primary' | 'secondary';
  sessionId: string | null;
  surface?: 'chat' | 'terminal';
}

export interface LegacyPaneFields {
  chatLayoutMode: 'single' | 'split';
  savedSplitVisible: boolean;
  activePaneId: 'primary' | 'secondary';
  chatPanes: { primary: LegacyPaneState; secondary: LegacyPaneState };
  chatSplitRatio: number;
}

export interface LegacyPersisted {
  chatLayoutMode?: 'single' | 'split';
  activePaneId?: 'primary' | 'secondary' | string;
  chatPanes?: {
    primary?: { sessionId?: string | null; surface?: 'chat' | 'terminal' };
    secondary?: { sessionId?: string | null; surface?: 'chat' | 'terminal' };
  };
  chatSplitRatio?: number;
}

// ---- Derivation: tree -> legacy two-pane fields -----------------------------

/**
 * Project the (possibly N-pane) tree onto the legacy two-pane shape so existing
 * consumers (FolderTreeView, env context, Sidebar) keep working. When the tree
 * has >2 leaves this is a best-effort projection of the first two leaves.
 */
export function deriveLegacyFields(layout: WorkspaceLayout): LegacyPaneFields {
  const leaves = allLeaves(layout.root);
  const primary = leaves[0];
  const secondary = leaves[1];
  const split = isSplit(layout);
  const activeLeaf = findLeaf(layout.root, layout.activePaneId) ?? primary;

  let chatSplitRatio = SPLIT_RATIO_DEFAULT;
  if (layout.root.type === 'split' && layout.root.children.length >= 2) {
    chatSplitRatio = clampRatio(layout.root.sizes[0]);
  }

  return {
    chatLayoutMode: split ? 'split' : 'single',
    savedSplitVisible: split,
    activePaneId: secondary && activeLeaf && activeLeaf.id === secondary.id ? 'secondary' : 'primary',
    chatSplitRatio,
    chatPanes: {
      primary: {
        id: 'primary',
        sessionId: primary ? primary.sessionId : null,
        surface: primary ? primary.surface : 'chat',
      },
      secondary: {
        id: 'secondary',
        sessionId: secondary ? secondary.sessionId : null,
        surface: secondary ? secondary.surface : 'chat',
      },
    },
  };
}

/** Map a legacy pane enum onto an actual leaf id in the current tree. */
export function legacyPaneToLeafId(layout: WorkspaceLayout, pane: 'primary' | 'secondary'): string {
  const leaves = allLeaves(layout.root);
  if (pane === 'secondary' && leaves[1]) return leaves[1].id;
  return leaves[0] ? leaves[0].id : firstLeaf(layout.root).id;
}

// ---- Migration: legacy blob / new blob -> WorkspaceLayout -------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePaneNode(value: unknown, seenIds: Set<string>): PaneNode | null {
  if (!isPlainObject(value)) return null;
  const id = value.id;
  if (typeof id !== 'string' || seenIds.has(id)) return null;
  seenIds.add(id);

  if (value.type === 'leaf') {
    const sessionId = value.sessionId;
    const surface = value.surface === 'terminal' ? 'terminal' : 'chat';
    return makeLeaf(id, typeof sessionId === 'string' ? sessionId : null, surface);
  }
  if (value.type === 'split') {
    const orientation = value.orientation === 'col' ? 'col' : 'row';
    const rawChildren = Array.isArray(value.children) ? value.children : [];
    const children: PaneNode[] = [];
    for (const child of rawChildren) {
      const node = validatePaneNode(child, seenIds);
      if (node) children.push(node);
    }
    if (children.length < 2) {
      // Degenerate split: collapse to its single valid child, or fail.
      return children[0] ?? null;
    }
    const rawSizes = Array.isArray(value.sizes) ? (value.sizes as unknown[]) : [];
    const sizes =
      rawSizes.length === children.length
        ? rawSizes.map((s) => (typeof s === 'number' ? s : 0))
        : undefined;
    return makeSplit(id, orientation, children, sizes);
  }
  return null;
}

/** Deserialize + structurally validate an already-new layout blob. */
export function deserializeLayout(value: unknown): WorkspaceLayout | null {
  if (!isPlainObject(value)) return null;
  const root = validatePaneNode(value.root, new Set<string>());
  if (!root) return null;
  const leafIds = new Set(allLeaves(root).map((leaf) => leaf.id));
  const activePaneId =
    typeof value.activePaneId === 'string' && leafIds.has(value.activePaneId)
      ? value.activePaneId
      : firstLeaf(root).id;
  const focusOrder = Array.isArray(value.focusOrder)
    ? (value.focusOrder.filter((id): id is string => typeof id === 'string' && leafIds.has(id)))
    : [activePaneId];
  return { root, activePaneId, focusOrder: focusOrder.length ? focusOrder : [activePaneId] };
}

/** Build a WorkspaceLayout from legacy two-pane persisted fields. Deterministic. */
export function migrateLegacyToLayout(legacy: LegacyPersisted | null | undefined): WorkspaceLayout {
  const primarySession = legacy?.chatPanes?.primary?.sessionId ?? null;
  const secondarySession = legacy?.chatPanes?.secondary?.sessionId ?? null;
  const primarySurface = legacy?.chatPanes?.primary?.surface === 'terminal' ? 'terminal' : 'chat';
  const secondarySurface = legacy?.chatPanes?.secondary?.surface === 'terminal' ? 'terminal' : 'chat';
  const split = legacy?.chatLayoutMode === 'split' && secondarySession !== null;

  const primaryLeaf = makeLeaf(MIGRATED_PRIMARY_ID, primarySession, primarySurface);
  if (!split) {
    return singleLayout(primaryLeaf);
  }
  const secondaryLeaf = makeLeaf(MIGRATED_SECONDARY_ID, secondarySession, secondarySurface);
  const ratio = clampRatio(legacy?.chatSplitRatio ?? SPLIT_RATIO_DEFAULT);
  const root = makeSplit('legacy-root', 'row', [primaryLeaf, secondaryLeaf], [ratio, 1 - ratio]);
  const activePaneId = legacy?.activePaneId === 'secondary' ? MIGRATED_SECONDARY_ID : MIGRATED_PRIMARY_ID;
  return { root, activePaneId, focusOrder: [activePaneId, MIGRATED_PRIMARY_ID, MIGRATED_SECONDARY_ID].filter((v, i, a) => a.indexOf(v) === i) };
}

/**
 * Single entry point used by both startup seams. Prefer an already-new
 * serialized layout; otherwise migrate the legacy two-pane fields; otherwise a
 * fresh single empty pane. Deterministic for a given input (no UUID minting).
 */
export function resolveWorkspaceLayout(persisted: {
  workspaceLayout?: unknown;
  schemaVersion?: number;
} & LegacyPersisted | null | undefined): WorkspaceLayout {
  if (persisted && persisted.workspaceLayout != null) {
    const deserialized = deserializeLayout(persisted.workspaceLayout);
    if (deserialized) return deserialized;
  }
  if (persisted && (persisted.chatPanes || persisted.chatLayoutMode)) {
    return migrateLegacyToLayout(persisted);
  }
  return singleLayout(makeLeaf(MIGRATED_PRIMARY_ID));
}

/** Re-normalize/repair a runtime layout (used after rehydrate as a safety net). */
export function repairLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const leafIds = new Set(allLeaves(layout.root).map((leaf) => leaf.id));
  if (leafIds.size === 0) return singleLayout(makeLeaf(MIGRATED_PRIMARY_ID));
  const activePaneId = leafIds.has(layout.activePaneId) ? layout.activePaneId : firstLeaf(layout.root).id;
  const focusOrder = layout.focusOrder.filter((id) => leafIds.has(id));
  return { ...layout, activePaneId, focusOrder: focusOrder.length ? focusOrder : [activePaneId] };
}

// Re-exports so the store imports a single module.
export type { LeafNode, PaneNode, SplitNode, WorkspaceLayout };
