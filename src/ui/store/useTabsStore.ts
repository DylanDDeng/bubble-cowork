import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import { useAppStore } from './useAppStore';
import { useBoardStore } from './useBoardStore';

/**
 * Browser-style tabs over the app's existing navigation. A tab does NOT own
 * its content — it is a bookmark of a navigation state (which workspace,
 * which session, which board task). Switching tabs replays that state into
 * the global stores; navigating inside the app writes the new state back
 * into the active tab (the mirror effect in App). This keeps every existing
 * navigation path working without rewiring its call sites.
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
}

export function sameTabView(a: TabView, b: TabView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'board' && b.kind === 'board') return a.taskId === b.taskId;
  if (a.kind === 'chat' && b.kind === 'chat') return a.sessionId === b.sessionId;
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
  /** Mirror direction: the app navigated — record it on the active tab. */
  setActiveTabView: (view: TabView) => void;
}

export const useTabsStore = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      openTab: (view, options) => {
        const { tabs } = get();
        const existing = tabs.find((tab) => sameTabView(tab.view, view));
        if (options?.background) {
          if (!existing) {
            set({ tabs: [...tabs, { id: makeTabId(), view }] });
          }
          return;
        }
        if (existing) {
          set({ activeTabId: existing.id });
        } else {
          const tab = { id: makeTabId(), view };
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
          const tab = { id: makeTabId(), view };
          set({ tabs: [...tabs, tab], activeTabId: tab.id });
          return;
        }
        if (sameTabView(active.view, view)) return;
        set({
          tabs: tabs.map((tab) => (tab.id === active.id ? { ...tab, view } : tab)),
        });
      },
    }),
    {
      name: 'cowork-tabs-storage',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 1,
    }
  )
);
