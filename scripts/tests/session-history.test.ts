import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canMoveSessionHistory,
  pushSessionHistory,
  SESSION_HISTORY_LIMIT,
  stepSessionHistory,
} from '../../src/ui/utils/session-history';
import {
  canNavigateActiveTab,
  isTabViewVisitable,
  sameTabView,
  useTabsStore,
  type AppTab,
  type TabView,
} from '../../src/ui/store/useTabsStore';
import { useAppStore } from '../../src/ui/store/useAppStore';

function visitable(alive: Set<string | null>) {
  return (entry: string | null) => alive.has(entry);
}

// --- generic stack -------------------------------------------------------

{
  const first = pushSessionHistory([], -1, 'a');
  assert.deepEqual(first.stack, ['a']);
  assert.equal(first.index, 0);

  const same = pushSessionHistory(first.stack, first.index, 'a');
  assert.equal(same.stack, first.stack, 'repeat visits must not grow the stack');
  assert.equal(same.index, 0);

  const second = pushSessionHistory(first.stack, first.index, 'b');
  assert.deepEqual(second.stack, ['a', 'b']);
  assert.equal(second.index, 1);
}

{
  const started = pushSessionHistory(['a', 'b', 'c'], 2, 'd');
  assert.deepEqual(started.stack, ['a', 'b', 'c', 'd']);

  const back = stepSessionHistory(started.stack, started.index, -1, () => true);
  assert.equal(back?.entry, 'c');
  const fromMiddle = pushSessionHistory(back!.stack, back!.index, 'e');
  assert.deepEqual(
    fromMiddle.stack,
    ['a', 'b', 'c', 'e'],
    'pushing after back must drop the forward branch'
  );
  assert.equal(fromMiddle.index, 3);
}

{
  const stack = ['a', 'gone', 'c'];
  const alive = visitable(new Set(['a', 'c', null]));
  const skipped = stepSessionHistory(stack, 2, -1, alive);
  assert.equal(skipped?.entry, 'a', 'back must skip deleted sessions');
  assert.equal(canMoveSessionHistory(stack, 0, -1, alive), false);
  assert.equal(canMoveSessionHistory(stack, 0, 1, alive), true);
}

{
  let state = { stack: [] as Array<string | null>, index: -1 };
  for (let i = 0; i < SESSION_HISTORY_LIMIT + 8; i += 1) {
    state = pushSessionHistory(state.stack, state.index, `s${i}`);
  }
  assert.equal(state.stack.length, SESSION_HISTORY_LIMIT);
  assert.equal(state.stack[0], 's8');
  assert.equal(state.stack.at(-1), `s${SESSION_HISTORY_LIMIT + 7}`);
}

{
  // Structural entries dedupe through the caller's equality, not identity.
  const list: TabView = { kind: 'chat', sessionId: null };
  const pushed = pushSessionHistory([list], 0, { kind: 'chat', sessionId: null }, sameTabView);
  assert.equal(pushed.stack.length, 1, 'an equal view must not be pushed twice');
}

// --- per-tab history in the tabs store ------------------------------------

const prs: TabView = { kind: 'prs' };
const chat = (sessionId: string | null): TabView => ({ kind: 'chat', sessionId });

function activeTab(): AppTab {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((entry) => entry.id === activeTabId);
  assert.ok(tab, 'an active tab must exist');
  return tab;
}

const sessionX = useAppStore.getState().createDraftSession('/projects/x');
const sessionY = useAppStore.getState().createDraftSession('/projects/y');
useTabsStore.setState({ tabs: [], activeTabId: null });

const { setActiveTabView, goBack, goForward, openTab, activateTab, closeTab } =
  useTabsStore.getState();

// The mirror effect records each navigation on the active tab.
setActiveTabView(prs);
assert.deepEqual(activeTab().history, [prs], 'the first view seeds the tab history');
setActiveTabView(chat(sessionX));
setActiveTabView(prs);
setActiveTabView(chat(sessionY));
assert.equal(activeTab().history.length, 4);
assert.equal(activeTab().historyIndex, 3);
assert.equal(canNavigateActiveTab(useTabsStore.getState(), -1, () => true), true);
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), false);

// Back lands on the previous view and replays it into the global stores.
goBack();
assert.deepEqual(activeTab().view, prs, 'back from a session returns to the previous workspace');
assert.equal(useAppStore.getState().activeWorkspace, 'prs');
goBack();
assert.deepEqual(activeTab().view, chat(sessionX));
assert.equal(useAppStore.getState().activeSessionId, sessionX, 'replay reselects the session');

// The mirror effect re-reporting the landing view must not push it again.
setActiveTabView(chat(sessionX));
assert.equal(activeTab().history.length, 4, 'replay must not grow the stack');
assert.equal(activeTab().historyIndex, 1, 'replay must not move the cursor');
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), true);

goForward();
assert.deepEqual(activeTab().view, prs);
goForward();
assert.deepEqual(activeTab().view, chat(sessionY));
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), false);

// A fresh navigation after going back drops the forward branch.
goBack();
goBack();
setActiveTabView(chat(null));
assert.deepEqual(activeTab().history, [prs, chat(sessionX), chat(null)]);

// A deleted session is skipped, the new-session landing (null) never is.
const { [sessionX]: _removed, ...remaining } = useAppStore.getState().sessions;
useAppStore.setState({ sessions: remaining });
const sessions = useAppStore.getState().sessions;
assert.equal(isTabViewVisitable(chat(sessionX), sessions), false);
assert.equal(isTabViewVisitable(chat(sessionY), sessions), true);
assert.equal(isTabViewVisitable(chat(null), sessions), true);
assert.equal(isTabViewVisitable(prs, sessions), true);
goBack();
assert.deepEqual(activeTab().view, prs, 'back must skip the deleted session');
goForward();
assert.deepEqual(activeTab().view, chat(null));

// History belongs to the tab: another tab starts clean and switching back
// restores the first tab's stack untouched.
const firstTabId = activeTab().id;
const firstHistory = activeTab().history;
openTab({ kind: 'automations' });
const secondTabId = activeTab().id;
assert.notEqual(secondTabId, firstTabId);
assert.equal(canNavigateActiveTab(useTabsStore.getState(), -1, () => true), false);
setActiveTabView({ kind: 'prs' });
assert.equal(activeTab().history.length, 2);
activateTab(firstTabId);
assert.equal(activeTab().history, firstHistory, 'switching tabs must not touch the other stack');
assert.deepEqual(activeTab().view, chat(null));

// Closing a tab takes its history with it.
closeTab(secondTabId);
assert.equal(useTabsStore.getState().tabs.some((tab) => tab.id === secondTabId), false);

// Persisted v1 tabs (no history) are seeded with their current view.
const migrate = useTabsStore.persist.getOptions().migrate!;
const migrated = migrate({ tabs: [{ id: 't1', view: prs }], activeTabId: 't1' }, 1) as {
  tabs: AppTab[];
};
assert.deepEqual(migrated.tabs[0].history, [prs]);
assert.equal(migrated.tabs[0].historyIndex, 0);

// Views of the removed Kanban board are dropped on upgrade; a tab that held
// nothing else goes with them and the active tab falls back to a survivor.
{
  const legacyBoard = { kind: 'board', taskId: 'task-1' } as unknown as TabView;
  const legacyList = { kind: 'board', taskId: null } as unknown as TabView;
  const upgraded = migrate(
    {
      tabs: [
        { id: 'mixed', view: legacyBoard, history: [chat(sessionY), legacyList, legacyBoard, prs], historyIndex: 2 },
        { id: 'board-only', view: legacyList, history: [legacyList], historyIndex: 0 },
      ],
      activeTabId: 'board-only',
    },
    2
  ) as { tabs: AppTab[]; activeTabId: string | null };
  assert.deepEqual(upgraded.tabs.map((tab) => tab.id), ['mixed']);
  assert.deepEqual(upgraded.tabs[0].history, [chat(sessionY), prs]);
  assert.equal(upgraded.tabs[0].historyIndex, 0, 'the cursor lands on the last live view at or before it');
  assert.deepEqual(upgraded.tabs[0].view, chat(sessionY));
  assert.equal(upgraded.activeTabId, 'mixed');
}

// --- chrome placement -------------------------------------------------------

async function main() {
  for (const file of ['AppTabBar.tsx', 'Sidebar.tsx']) {
    const source = await readFile(
      new URL(`../../src/ui/components/${file}`, import.meta.url),
      'utf8'
    );
    assert.match(source, /<SessionHistoryButtons/, `${file} must render back/forward`);
  }

  const buttonsSource = await readFile(
    new URL('../../src/ui/components/SessionHistoryButtons.tsx', import.meta.url),
    'utf8'
  );
  assert.match(buttonsSource, /useTabsStore/, 'back/forward must drive the tab history');

  const { shortcutBindings } = await import('../../src/shared/keyboard-shortcuts');
  assert.deepEqual(shortcutBindings('back'), ['Mod+BracketLeft']);
  assert.deepEqual(shortcutBindings('forward'), ['Mod+BracketRight']);

  console.log('session-history tests passed');
}

void main();
