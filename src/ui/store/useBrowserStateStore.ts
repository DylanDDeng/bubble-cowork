import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Stores lightweight browser metadata per session (tabs list, recent history)
// so the chrome can render immediately on session switch before the main
// process sends its live state. Based on dpcode's browserStateStore.
const BROWSER_STATE_STORAGE_KEY = 'coworker:browser-state:v1';
const BROWSER_HISTORY_LIMIT = 12;

export interface PersistedBrowserTab {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface PersistedSessionBrowserState {
  sessionId: string;
  activeTabId: string | null;
  tabs: PersistedBrowserTab[];
  updatedAt: number;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  faviconUrl: string | null;
  lastVisitedAt: number;
}

interface BrowserStateStore {
  sessionStatesBySessionId: Record<string, PersistedSessionBrowserState>;
  recentHistoryBySessionId: Record<string, BrowserHistoryEntry[]>;
  upsertSessionState: (state: PersistedSessionBrowserState) => void;
  removeSessionState: (sessionId: string) => void;
  recordHistoryEntry: (sessionId: string, entry: BrowserHistoryEntry) => void;
}

export const useBrowserStateStore = create<BrowserStateStore>()(
  persist(
    (set) => ({
      sessionStatesBySessionId: {},
      recentHistoryBySessionId: {},
      upsertSessionState: (state) => {
        set((prev) => ({
          sessionStatesBySessionId: {
            ...prev.sessionStatesBySessionId,
            [state.sessionId]: state,
          },
        }));
      },
      removeSessionState: (sessionId) => {
        set((prev) => {
          if (
            !(sessionId in prev.sessionStatesBySessionId) &&
            !(sessionId in prev.recentHistoryBySessionId)
          ) {
            return prev;
          }
          const { [sessionId]: _dropState, ...restStates } = prev.sessionStatesBySessionId;
          const { [sessionId]: _dropHistory, ...restHistory } = prev.recentHistoryBySessionId;
          void _dropState;
          void _dropHistory;
          return {
            sessionStatesBySessionId: restStates,
            recentHistoryBySessionId: restHistory,
          };
        });
      },
      recordHistoryEntry: (sessionId, entry) => {
        if (!entry.url || entry.url === 'about:blank') return;
        set((prev) => {
          const existing = prev.recentHistoryBySessionId[sessionId] ?? [];
          const filtered = existing.filter((item) => item.url !== entry.url);
          const next = [entry, ...filtered].slice(0, BROWSER_HISTORY_LIMIT);
          return {
            recentHistoryBySessionId: {
              ...prev.recentHistoryBySessionId,
              [sessionId]: next,
            },
          };
        });
      },
    }),
    {
      name: BROWSER_STATE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
    }
  )
);
