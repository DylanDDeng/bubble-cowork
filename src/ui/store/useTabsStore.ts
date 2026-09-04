import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import {
  canMoveSessionHistory,
  pushSessionHistory,
  stepSessionHistory,
} from '../utils/session-history';
import { useAppStore } from './useAppStore';
import { useBoardStore } from './useBoardStore';

/**
 * Browser-style tabs over the app's existing navigation. A tab does NOT own
 * its content — it is a bookmark of a navigation state (which workspace,
 * which session, which board task). Switching tabs replays that state into
 * the global stores; navigating inside the app writes the new state back
 * into the active tab (the mirror effect in App). This keeps every existing
 * navigation path working without rewiring its call sites.
 *
 * Each tab also carries its own back/forward history, like a browser tab:
 * every view the mirror effect records is pushed onto it, and Back/Forward
 * step through it and replay the landing view. Because the stack lives on
 * the tab, switching or closing tabs never leaks history across them.
 */
export type TabView =
  | { kind: 'board'; taskId: string | null }
  | { kind: 'chat'; sessionId: string | null }
  | { kind: 'automations' }
  | { kind: 'prs' }
  | { kind: 'skills' };

export interface AppTab {
  id: string;
  view: TabView;
  /** Views visited in this tab, oldest first; `view` is `history[historyIndex]`. */
  history: TabView[];
  historyIndex: number;
}

export function sameTabView(a: TabView, b: TabView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'board' && b.kind === 'board') return a.taskId === b.taskId;
  if (a.kind === 'chat' && b.kind === 'chat') return a.sessionId === b.sessionId;
  return true;
}

/**
 * Whether a history entry can still be shown: a chat whose session was
 * deleted or a board task that was removed is skipped when stepping.
 */
export function isTabViewVisitable(
  view: TabView,
  sessions: Record<string, unknown>,
  boardTasks: Record<string, unknown>
): boolean {
  if (view.kind === 'chat') return view.sessionId === null || Boolean(sessions[view.sessionId]);
  if (view.kind === 'board') return view.taskId === null || Boolean(boardTasks[view.taskId]);
  return true;
}

/** Replay a tab's bookmarked navigation state into the global stores. */
function applyTabView(view: TabView): void {
  const app = useAppStore.getState();
  if (view.kind === 'board') {
    useBoardStore.getState().setSelectedTask(view.taskId);
    app.setActiveWorkspace('board');
    return;
  }
  if (view.kind === 'chat') {
    app.setActiveWorkspace('chat');
    if (view.sessionId) {
      app.setActiveSession(view.sessionId);
      app.setShowNewSession(false);
    } else {
      app.setShowNewSession(true);
    }
    return;
  }
  app.setActiveWorkspace(view.kind);
}

function makeTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTab(view: TabView): AppTab {
  return { id: makeTabId(), view, history: [view], historyIndex: 0 };
}

function currentVisitable(): (view: TabView) => boolean {
  const sessions = useAppStore.getState().sessions;
  const tasks = useBoardStore.getState().tasks;
  return (view) => isTabViewVisitable(view, sessions, tasks);
}

interface TabsStore {
  tabs: AppTab[];
  activeTabId: string | null;
  /**
   * Open a view as a tab. Foreground opens activate an existing tab with the
   * same view instead of duplicating; background opens are no-ops when a
   * duplicate exists.
   */
  openTab: (view: TabView, options?: { background?: boolean }) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  /** Record the app's current navigation state on the active tab. */
  setActiveTabView: (view: TabView) => void;
  /** Step the active tab's history and replay the landing view. */
  goBack: () => void;
  goForward: () => void;
}

export const useTabsStore = create<TabsStore>()(
  persist(
    (set, get) => {
      const navigateHistory = (direction: -1 | 1) => {
        const { tabs, activeTabId } = get();
        const active = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;
        if (!active) return;
        const moved = stepSessionHistory(
          active.history,
          active.historyIndex,
          direction,
          currentVisitable()
        );
        if (!moved) return;
        set({
          tabs: tabs.map((tab) =>
            tab.id === active.id ? { ...tab, view: moved.entry, historyIndex: moved.index } : tab
          ),
        });
        // The mirror effect in App fires after this replay settles and sees
        // the landing view already recorded as `tab.view`, so it does not
        // push it again (which would drop the forward branch).
        applyTabView(moved.entry);
      };

      return {
        tabs: [],
        activeTabId: null,

        openTab: (view, options) => {
          const { tabs } = get();
          const existing = tabs.find((tab) => sameTabView(tab.view, view));
          if (options?.background) {
            if (!existing) {
              set({ tabs: [...tabs, makeTab(view)] });
            }
            return;
          }
          if (existing) {
            set({ activeTabId: existing.id });
          } else {
            const tab = makeTab(view);
            set({ tabs: [...tabs, tab], activeTabId: tab.id });
          }
          applyTabView(view);
        },

        activateTab: (tabId) => {
          const tab = get().tabs.find((entry) => entry.id === tabId);
          if (!tab || get().activeTabId === tabId) return;
          set({ activeTabId: tabId });
          applyTabView(tab.view);
        },

        closeTab: (tabId) => {
          const { tabs, activeTabId } = get();
          if (tabs.length <= 1) return;
          const index = tabs.findIndex((entry) => entry.id === tabId);
          if (index === -1) return;
          const next = tabs.filter((entry) => entry.id !== tabId);
          if (activeTabId === tabId) {
            const fallback = next[Math.min(index, next.length - 1)];
            set({ tabs: next, activeTabId: fallback.id });
            applyTabView(fallback.view);
          } else {
            set({ tabs: next });
          }
        },

        setActiveTabView: (view) => {
          const { tabs, activeTabId } = get();
          const active = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;
          if (!active) {
            // First navigation of the app run — seed the initial tab from it.
            const tab = makeTab(view);
            set({ tabs: [...tabs, tab], activeTabId: tab.id });
            return;
          }
          if (sameTabView(active.view, view)) return;
          const history = pushSessionHistory(
            active.history,
            active.historyIndex,
            view,
            sameTabView
          );
          set({
            tabs: tabs.map((tab) =>
              tab.id === active.id
                ? { ...tab, view, history: history.stack, historyIndex: history.index }
                : tab
            ),
          });
        },

        goBack: () => navigateHistory(-1),
        goForward: () => navigateHistory(1),
      };
    },
    {
      name: 'cowork-tabs-storage',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as Partial<TabsStore> | undefined;
        // v1 tabs had no history; seed each with its current view.
        const tabs = (state?.tabs ?? []).map((tab) => {
          const legacy = tab as Partial<AppTab> & { view: TabView };
          return Array.isArray(legacy.history) && legacy.history.length > 0
            ? (legacy as AppTab)
            : { ...legacy, history: [legacy.view], historyIndex: 0 };
        });
        return { ...state, tabs };
      },
    }
  )
);

/** Whether Back/Forward can move on the active tab, for the chrome buttons. */
export function canNavigateActiveTab(
  state: Pick<TabsStore, 'tabs' | 'activeTabId'>,
  direction: -1 | 1,
  isVisitable: (view: TabView) => boolean
): boolean {
  const active = state.activeTabId
    ? state.tabs.find((tab) => tab.id === state.activeTabId)
    : undefined;
  if (!active) return false;
  return canMoveSessionHistory(active.history, active.historyIndex, direction, isVisitable);
}
