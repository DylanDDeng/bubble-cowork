import assert from 'node:assert/strict';
import {
  DEFAULT_SIDEBAR_VIEW,
  deriveSidebarSessionState,
  isDefaultSidebarView,
  isWithinActivityWindow,
  sessionSortTime,
} from '../../src/ui/utils/sidebar-view';
import type { GitPullRequestSummary } from '../../src/shared/types';

// Isolated persistence: exercise the real store without the renderer bridge.
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
  configurable: true,
});

type StateInput = Parameters<typeof deriveSidebarSessionState>[0];
const idle: StateInput = { status: 'completed', permissionRequests: [], runtimeNotice: undefined, envMode: 'local', worktreePath: null };
const pr = (state: GitPullRequestSummary['state']): GitPullRequestSummary => ({
  number: 7,
  title: 'Sidebar view options',
  state,
  url: 'https://github.com/o/r/pull/7',
});
const permission = { toolUseId: 't', toolName: 'Bash', input: {} } as unknown as StateInput['permissionRequests'][number];

// --- state derivation -------------------------------------------------------

assert.equal(deriveSidebarSessionState({ ...idle, status: 'running', permissionRequests: [permission] }, {}), 'needs-input',
  'a pending approval outranks running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'running' }, {}), 'running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'stopping' }, {}), 'running');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'error', runtimeNotice: 'error' }, {}), 'needs-input', 'an unseen failure needs you');
assert.equal(deriveSidebarSessionState({ ...idle, status: 'error' }, {}), 'completed', 'a failure already looked at does not linger');
assert.equal(deriveSidebarSessionState({ ...idle, runtimeNotice: 'completed' }, {}), 'review', 'an unseen result is ready for review');
assert.equal(deriveSidebarSessionState(idle, { unread: true }), 'review', 'marked unread stays in review');
assert.equal(deriveSidebarSessionState(idle, { pullRequest: pr('open') }), 'review', 'an open PR waits on review');
assert.equal(deriveSidebarSessionState(idle, {}), 'completed');
assert.equal(deriveSidebarSessionState(idle, { pullRequest: pr('merged') }), 'completed');

const worktree: StateInput = { ...idle, envMode: 'worktree', worktreePath: '/p/.worktrees/a' };
assert.equal(deriveSidebarSessionState(worktree, {}), 'review', 'a live worktree holds work not applied back yet');
assert.equal(deriveSidebarSessionState(worktree, { pullRequest: pr('merged') }), 'completed', 'a merged PR closes the loop');
assert.equal(deriveSidebarSessionState(worktree, { pullRequest: pr('closed') }), 'completed');
assert.equal(deriveSidebarSessionState({ ...worktree, worktreePath: null }, {}), 'completed',
  'applying or discarding the worktree clears it');

// --- filters and sorting ----------------------------------------------------

const now = Date.UTC(2026, 8, 28, 12);
const day = 24 * 60 * 60 * 1000;
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, 'all', now), true);
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, '7d', now), true);
assert.equal(isWithinActivityWindow({ updatedAt: now - 3 * day }, '1d', now), false);
assert.equal(isWithinActivityWindow({ updatedAt: now - 31 * day }, '30d', now), false);

assert.equal(sessionSortTime({ updatedAt: 20, createdAt: 10 }, 'updated'), 20);
assert.equal(sessionSortTime({ updatedAt: 20, createdAt: 10 }, 'created'), 10);
assert.equal(sessionSortTime({ updatedAt: 20 }, 'created'), 20, 'sessions without a creation time fall back');

assert.equal(isDefaultSidebarView(DEFAULT_SIDEBAR_VIEW), true);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'state' }), false);
assert.equal(isDefaultSidebarView({ ...DEFAULT_SIDEBAR_VIEW, project: '/p' }), false);

// --- store ------------------------------------------------------------------

async function main() {
  const { useSidebarViewStore } = await import('../../src/ui/store/useSidebarViewStore');
  const store = useSidebarViewStore;

  store.getState().setOption('groupBy', 'date');
  store.getState().toggleStateView();
  assert.equal(store.getState().groupBy, 'state', 'the shortcut switches to Group by State');
  store.getState().toggleStateView();
  assert.equal(store.getState().groupBy, 'date', 'pressing it again restores the previous grouping');

  store.getState().setOption('status', 'archived');
  store.getState().reset();
  assert.equal(store.getState().status, 'active');
  assert.equal(store.getState().groupBy, 'project');

  // Unknown or stale persisted values fall back instead of breaking the list.
  const merge = store.persist.getOptions().merge!;
  const merged = merge(
    { status: 'bogus', groupBy: 'state', activity: '7d', showPullRequests: 'yes', project: '' },
    store.getState()
  ) as ReturnType<typeof store.getState>;
  assert.equal(merged.status, 'active');
  assert.equal(merged.groupBy, 'state');
  assert.equal(merged.activity, '7d');
  assert.equal(merged.showPullRequests, true);
  assert.equal(merged.project, null);

  console.log('sidebar-view tests passed');
}

void main();
