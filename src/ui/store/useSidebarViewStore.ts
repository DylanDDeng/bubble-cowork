import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';
import {
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_ACTIVITY_LABELS,
  SIDEBAR_GROUP_LABELS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_STATUS_LABELS,
  type SidebarGroupBy,
  type SidebarViewOptions,
} from '../utils/sidebar-view';

interface SidebarViewStore extends SidebarViewOptions {
  /** Grouping to return to when the state-view shortcut is pressed again. */
  previousGroupBy: SidebarGroupBy;
  setOption: <K extends keyof SidebarViewOptions>(key: K, value: SidebarViewOptions[K]) => void;
  toggleStateView: () => void;
  reset: () => void;
}

function pickValid<T extends string>(value: unknown, labels: Record<T, string>, fallback: T): T {
  return typeof value === 'string' && value in labels ? (value as T) : fallback;
}

export const useSidebarViewStore = create<SidebarViewStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SIDEBAR_VIEW,
      previousGroupBy: DEFAULT_SIDEBAR_VIEW.groupBy,
      setOption: (key, value) => set({ [key]: value } as Partial<SidebarViewStore>),
      toggleStateView: () =>
        set((state) =>
          state.groupBy === 'state'
            ? { groupBy: state.previousGroupBy === 'state' ? DEFAULT_SIDEBAR_VIEW.groupBy : state.previousGroupBy }
            : { groupBy: 'state', previousGroupBy: state.groupBy }
        ),
      reset: () => set({ ...DEFAULT_SIDEBAR_VIEW }),
    }),
    {
      name: 'cowork-sidebar-view',
      storage: createJSONStorage(() => rendererStateStorage),
      version: 1,
      partialize: ({ status, project, activity, groupBy, sortBy, showPullRequests, previousGroupBy }) => ({
        status, project, activity, groupBy, sortBy, showPullRequests, previousGroupBy,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SidebarViewStore>;
        return {
          ...current,
          status: pickValid(saved.status, SIDEBAR_STATUS_LABELS, current.status),
          project: typeof saved.project === 'string' && saved.project ? saved.project : null,
          activity: pickValid(saved.activity, SIDEBAR_ACTIVITY_LABELS, current.activity),
          groupBy: pickValid(saved.groupBy, SIDEBAR_GROUP_LABELS, current.groupBy),
          previousGroupBy: pickValid(saved.previousGroupBy, SIDEBAR_GROUP_LABELS, current.previousGroupBy),
          sortBy: pickValid(saved.sortBy, SIDEBAR_SORT_LABELS, current.sortBy),
          showPullRequests: typeof saved.showPullRequests === 'boolean' ? saved.showPullRequests : current.showPullRequests,
        };
      },
    }
  )
);

export function useSidebarViewOptions(): SidebarViewOptions {
  const status = useSidebarViewStore((s) => s.status);
  const project = useSidebarViewStore((s) => s.project);
  const activity = useSidebarViewStore((s) => s.activity);
  const groupBy = useSidebarViewStore((s) => s.groupBy);
  const sortBy = useSidebarViewStore((s) => s.sortBy);
  const showPullRequests = useSidebarViewStore((s) => s.showPullRequests);
  return { status, project, activity, groupBy, sortBy, showPullRequests };
}
