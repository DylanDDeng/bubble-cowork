#!/usr/bin/env node
// Verifies the recursive tiling workspace: dragging a session onto a pane edge
// splits in that direction (no center "replace" zone), dropping onto an empty
// pane fills it, the store drives panes from the workspaceLayout tree, and Side
// Chat is folded into the tree (no separate docked panel).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- WorkspaceHost renders the tree + drag-to-edge splitting ---------------
const workspaceHost = read('src/ui/components/WorkspaceHost.tsx');
assert.ok(
  workspaceHost.includes('function computeDropEdge') &&
    /distLeft|distRight|distTop|distBottom/.test(workspaceHost),
  'WorkspaceHost must compute the drop edge from the cursor (diagonal quadrants)'
);
assert.ok(
  !workspaceHost.includes("return 'center'") && !workspaceHost.includes("=== 'center'"),
  'there must be no center "replace" drop zone (edges only)'
);
assert.ok(
  workspaceHost.includes('splitPaneAt(leaf.id, edge, sessionId)') &&
    workspaceHost.includes('placeSessionInPane(leaf.id, sessionId)'),
  'edge drops must splitPaneAt; empty-pane drops must placeSessionInPane'
);
assert.ok(
  workspaceHost.includes('resizeSplitById') &&
    workspaceHost.includes("orientation === 'row'") &&
    workspaceHost.includes('clientWidth') &&
    workspaceHost.includes('clientHeight'),
  'split resizers must be axis-aware and commit via resizeSplitById'
);
assert.ok(
  workspaceHost.includes('setLiveSizes') && workspaceHost.includes("addEventListener('mouseup'"),
  'resize must use transient local sizes and commit on mouseup (no per-tick store writes)'
);
assert.ok(
  workspaceHost.includes('const LeafPane = memo(') && workspaceHost.includes('PaneRenderer'),
  'leaf panes must be memoized and rendered through a recursive PaneRenderer'
);
assert.ok(
  workspaceHost.includes('MIN_PANE_PX') && /minFrac/.test(workspaceHost),
  'resizing must clamp panes to a pixel minimum'
);
assert.ok(
  workspaceHost.includes('setActivePaneById(leaf.id)') &&
    workspaceHost.includes('closePaneById(leaf.id)'),
  'panes must activate and close by leaf id'
);

// --- ChatPane: paneId widened to string; drop handled by the host ----------
const chatPane = read('src/ui/components/ChatPane.tsx');
assert.ok(/paneId:\s*string;/.test(chatPane), 'ChatPane.paneId must be a string (leaf id)');
assert.ok(
  chatPane.includes('session:${sessionId}') || chatPane.includes('`session:'),
  'scroll position must key on the session, not the pane id'
);

// --- Store drives panes from the workspaceLayout tree ----------------------
const store = read('src/ui/store/useAppStore.ts');
const closeSplitChat = store.match(/closeSplitChat: \(\) => \{[\s\S]*?\n  \},/)?.[0] || '';
assert.ok(
  closeSplitChat.includes('tree.singleLayout') && closeSplitChat.includes('layoutPatch'),
  'closeSplitChat must collapse the workspace layout tree to a single focused pane'
);
assert.ok(
  store.includes('layoutPatch(') &&
    store.includes("from './layout-tree'") &&
    store.includes("from './layout-adapter'") &&
    store.includes('splitPaneAt:') &&
    store.includes('closePaneById:') &&
    store.includes('placeSessionInPane:') &&
    // Guard the stale-tree bug class: session-routing paths (new session, DM,
    // workspace switch) must update the tree, never write the active pane
    // directly, or the focused pane renders empty while the session exists.
    !store.includes('[state.activePaneId]: {') &&
    !store.includes('[current.activePaneId]: {'),
  'the store must expose the tiling actions and drive panes via layoutPatch (no direct chatPanes[activePaneId] writes)'
);

// --- Side Chat folded into the tree (no docked panel) ----------------------
const app = read('src/ui/App.tsx');
assert.ok(
  !app.includes('<RightSideChatPanel'),
  'the docked RightSideChatPanel must no longer be rendered'
);
assert.ok(
  !/dockSecondaryPane=\{/.test(app),
  'WorkspaceHost must no longer receive dockSecondaryPane'
);
assert.ok(
  app.includes("splitPaneAt(store.workspaceLayout.activePaneId, 'right', null)"),
  'the Side Chat launcher must split the active pane to the right'
);

console.log('side-chat-drop: tiling wiring checks passed');
