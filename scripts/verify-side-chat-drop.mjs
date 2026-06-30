#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const app = read('src/ui/App.tsx');
const rightSideChatPanel = app.match(/function RightSideChatPanel\([\s\S]*?\n}\n\nfunction RightUtilityTabStrip/)?.[0] || '';
const activateRightUtilityContent = app.match(/const activateRightUtilityContent = useCallback\([\s\S]*?\n  \}, \[/)?.[0] || '';

assert.ok(
  !app.includes("openSplitChat('secondary', null)") &&
    activateRightUtilityContent.includes("if (targetKind === 'side-chat')") &&
    !activateRightUtilityContent.includes("openSplitChat('secondary', null)"),
  'Opening Side Chat must not activate an empty secondary pane before a session is dropped'
);

assert.ok(
  rightSideChatPanel.includes('openSplitChat') &&
    rightSideChatPanel.includes("openSplitChat('secondary', sessionId)") &&
    rightSideChatPanel.includes('sideChatDropActive') &&
    rightSideChatPanel.includes("dropHint={sideChatDropActive ? 'Open in Side Chat' : null}") &&
    rightSideChatPanel.includes("event.dataTransfer.types.includes('application/x-aegis-session-id')"),
  'RightSideChatPanel must accept sidebar session drops and route them into the secondary pane'
);

assert.ok(
  rightSideChatPanel.includes('setSideChatDropActive(false)') &&
    rightSideChatPanel.includes("event.dataTransfer.dropEffect = 'move'"),
  'RightSideChatPanel must clear drop state and expose move feedback during session drag'
);

const chatPane = read('src/ui/components/ChatPane.tsx');
const showThreadStarter = chatPane.match(/const showThreadStarter = Boolean\([\s\S]*?\n  \);/)?.[0] || '';
assert.ok(
  showThreadStarter.includes('session.messages.length === 0') &&
    showThreadStarter.includes('session.hydrated'),
  'showThreadStarter must gate on session.hydrated so an existing session loading its history does not flash the New Thread landing (e.g. when dropped into the Side Chat)'
);
const chatPaneDropHandler = chatPane.match(/const handleDrop = \(event: React\.DragEvent<HTMLDivElement>\) => \{[\s\S]*?\n  \};/)?.[0] || '';
assert.ok(
  chatPane.includes("event.dataTransfer.getData('application/x-aegis-session-id')") &&
    chatPane.includes('event.stopPropagation()') &&
    chatPane.includes('onDropSession(droppedSessionId)') &&
    chatPane.includes('event.dataTransfer.dropEffect = \'move\''),
  'ChatPane must keep accepting session drops even when a session is already loaded'
);
assert.ok(
  chatPaneDropHandler.includes('onDropSession(droppedSessionId)') &&
    !chatPaneDropHandler.includes('onActivate()'),
  'ChatPane drop must commit the dropped session atomically without first activating an empty pane'
);
assert.ok(
  chatPane.includes('if (!isActive && (sessionId || !onDropSession))') &&
    chatPane.includes('onActivate();'),
  'Empty drop-only panes must not become active before a session is assigned'
);

const store = read('src/ui/store/useAppStore.ts');
// closeSplitChat collapses the recursive tiling tree to a single pane showing
// the focused session — the "reopen empty / no stale content" guarantee now
// lives in the layout-tree (covered by verify:layout-tree).
const closeSplitChat = store.match(/closeSplitChat: \(\) => \{[\s\S]*?\n  \},/)?.[0] || '';
assert.ok(
  closeSplitChat.includes('tree.singleLayout') && closeSplitChat.includes('layoutPatch'),
  'closeSplitChat must collapse the workspace layout tree to a single focused pane'
);
// Pane writes route through workspaceLayout (source of truth) via layoutPatch.
assert.ok(
  store.includes('layoutPatch(') &&
    store.includes("from './layout-tree'") &&
    store.includes("from './layout-adapter'"),
  'the store must drive panes from the workspaceLayout tree via layoutPatch'
);

const workspaceHost = read('src/ui/components/WorkspaceHost.tsx');
assert.ok(
  workspaceHost.includes('const applyDroppedSession') &&
    workspaceHost.includes('openSplitChat(paneId, sessionId)') &&
    workspaceHost.includes('onDropSession={(sessionId) =>') &&
    workspaceHost.includes('applyDroppedSession(paneId, sessionId)'),
  'WorkspaceHost split panes must continue using the same session drop path'
);
assert.ok(
  workspaceHost.includes('const primarySessionId =') &&
    workspaceHost.includes("dockSecondaryPane && chatLayoutMode === 'split'") &&
    workspaceHost.includes('chatPanes.primary.sessionId') &&
    workspaceHost.includes('sessionId={primarySessionId}'),
  'Docked Side Chat must render the main pane from primary pane state, not activeSessionId'
);

console.log('side-chat-drop: wiring checks passed');
