import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';

// Keep narrow-pane disclosure separate from the wide-pane pin preference.
// Component-local state is lost when navigating through Board or another task.
export const useEnvironmentPanelStore = create<{
  overlayBySession: Record<string, boolean>;
  setOverlayOpen: (sessionId: string, open: boolean) => void;
}>()(persist((set) => ({
  overlayBySession: {},
  setOverlayOpen: (sessionId, open) => set(state => ({
    overlayBySession: { ...state.overlayBySession, [sessionId]: open },
  })),
}), {
  name: 'environment-panel-state',
  storage: createJSONStorage(() => rendererStateStorage),
  partialize: state => ({ overlayBySession: state.overlayBySession }),
}));
