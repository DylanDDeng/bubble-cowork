import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { rendererStateStorage } from '../utils/renderer-state-storage';

// Keep narrow-pane disclosure separate from the wide-pane docked card.
// Component-local state is lost when navigating through Board or another task.
// The docked card starts open for every session; closing it only lasts for
// that session until the app restarts, so it is not persisted.
export const useEnvironmentPanelStore = create<{
  overlayBySession: Record<string, boolean>;
  dockedClosedBySession: Record<string, boolean>;
  setOverlayOpen: (sessionId: string, open: boolean) => void;
  setDockedOpen: (sessionId: string, open: boolean) => void;
}>()(persist((set) => ({
  overlayBySession: {},
  dockedClosedBySession: {},
  setOverlayOpen: (sessionId, open) => set(state => ({
    overlayBySession: { ...state.overlayBySession, [sessionId]: open },
  })),
  setDockedOpen: (sessionId, open) => set(state => ({
    dockedClosedBySession: { ...state.dockedClosedBySession, [sessionId]: !open },
  })),
}), {
  name: 'environment-panel-state',
  storage: createJSONStorage(() => rendererStateStorage),
  partialize: state => ({ overlayBySession: state.overlayBySession }),
}));
