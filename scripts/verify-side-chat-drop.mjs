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
const closeSplitChat = store.match(/closeSplitChat: \(\) => \{[\s\S]*?\n  \},/)?.[0] || '';
assert.ok(
  closeSplitChat.includes('secondary: {') &&
    /secondary: \{[\s\S]*?sessionId: null/.test(closeSplitChat),
  'closeSplitChat must clear the secondary pane so the Side Chat reopens empty instead of restoring stale content'
);

const normalizeChatPanes = store.match(/function normalizeChatPanes\([\s\S]*?\n}/)?.[0] || '';
assert.ok(
  normalizeChatPanes.includes('layoutMode: ChatLayoutMode') &&
    /secondary: \{[\s\S]*?layoutMode === 'split' \? panes\?\.secondary\?\.sessionId \?\? null : null/.test(
      normalizeChatPanes
    ),
  'normalizeChatPanes must drop a persisted secondary session unless the restored layout is split (self-heals stale Side Chat state on launch)'
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
