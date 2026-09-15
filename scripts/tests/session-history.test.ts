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
import { useBoardStore } from '../../src/ui/store/useBoardStore';

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
  const board: TabView = { kind: 'board', taskId: null };
  const pushed = pushSessionHistory([board], 0, { kind: 'board', taskId: null }, sameTabView);
  assert.equal(pushed.stack.length, 1, 'an equal view must not be pushed twice');
}

// --- per-tab history in the tabs store ------------------------------------

const boardList: TabView = { kind: 'board', taskId: null };
const boardTask = (taskId: string): TabView => ({ kind: 'board', taskId });
const chat = (sessionId: string | null): TabView => ({ kind: 'chat', sessionId });

function activeTab(): AppTab {
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((entry) => entry.id === activeTabId);
  assert.ok(tab, 'an active tab must exist');
  return tab;
}

useBoardStore.setState({ tasks: {}, selectedTaskId: null, excludedSessionIds: {} });
const taskX = useBoardStore.getState().addTask({ title: 'task X' });
const taskY = useBoardStore.getState().addTask({ title: 'task Y' });
useTabsStore.setState({ tabs: [], activeTabId: null });

const { setActiveTabView, goBack, goForward, openTab, activateTab, closeTab } =
  useTabsStore.getState();

// The mirror effect records each navigation on the active tab.
setActiveTabView(boardList);
assert.deepEqual(activeTab().history, [boardList], 'the first view seeds the tab history');
setActiveTabView(boardTask(taskX));
setActiveTabView(boardList);
setActiveTabView(boardTask(taskY));
assert.equal(activeTab().history.length, 4);
assert.equal(activeTab().historyIndex, 3);
assert.equal(canNavigateActiveTab(useTabsStore.getState(), -1, () => true), true);
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), false);

// Back lands on the previous view and replays it into the global stores.
goBack();
assert.deepEqual(activeTab().view, boardList, 'back from a task detail returns to the board list');
assert.equal(useAppStore.getState().activeWorkspace, 'board');
assert.equal(useBoardStore.getState().selectedTaskId, null);
goBack();
assert.deepEqual(activeTab().view, boardTask(taskX));
assert.equal(useBoardStore.getState().selectedTaskId, taskX, 'replay reselects the task');

// The mirror effect re-reporting the landing view must not push it again.
setActiveTabView(boardTask(taskX));
assert.equal(activeTab().history.length, 4, 'replay must not grow the stack');
assert.equal(activeTab().historyIndex, 1, 'replay must not move the cursor');
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), true);

goForward();
assert.deepEqual(activeTab().view, boardList);
goForward();
assert.deepEqual(activeTab().view, boardTask(taskY));
assert.equal(canNavigateActiveTab(useTabsStore.getState(), 1, () => true), false);

// A fresh navigation after going back drops the forward branch.
goBack();
goBack();
setActiveTabView(chat(null));
assert.deepEqual(activeTab().history, [boardList, boardTask(taskX), chat(null)]);

// A removed board task is skipped, a null task id (the list) never is.
useBoardStore.getState().removeTask(taskX);
const tasks = useBoardStore.getState().tasks;
assert.equal(isTabViewVisitable(boardTask(taskX), {}, tasks), false);
assert.equal(isTabViewVisitable(boardList, {}, tasks), true);
assert.equal(isTabViewVisitable(chat('missing'), {}, tasks), false);
assert.equal(isTabViewVisitable(chat(null), {}, tasks), true);
goBack();
assert.deepEqual(activeTab().view, boardList, 'back must skip the deleted task');
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
const migrated = migrate({ tabs: [{ id: 't1', view: boardList }], activeTabId: 't1' }, 1) as {
  tabs: AppTab[];
};
assert.deepEqual(migrated.tabs[0].history, [boardList]);
assert.equal(migrated.tabs[0].historyIndex, 0);

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
