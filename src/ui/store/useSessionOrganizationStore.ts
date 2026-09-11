import { toast } from 'sonner';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { SessionOrganizationChange, SessionOrganizationSnapshot } from '../../shared/session-organization';

export const useSessionOrganizationStore = create<SessionOrganizationSnapshot>(() => ({ sessions: {}, sections: [], projectSources: {} }));
let subscribers = 0;
let unsubscribe: (() => void) | undefined;
let sequence = 0;

export function useSessionOrganization() {
  useEffect(() => {
    if (!window.electron?.getSessionOrganization) return;
    subscribers++;
    if (subscribers === 1) {
      const request = ++sequence;
      unsubscribe = window.electron.onSessionOrganizationChanged(snapshot => {
        sequence++;
        useSessionOrganizationStore.setState(snapshot);
      });
      void window.electron.getSessionOrganization().then(snapshot => {
        if (request === sequence) useSessionOrganizationStore.setState(snapshot);
      }).catch(error => toast.error(`Could not load conversation organization: ${error instanceof Error ? error.message : error}`));
    }
    return () => {
      if (--subscribers === 0) { sequence++; unsubscribe?.(); unsubscribe = undefined; }
    };
  }, []);
  return useSessionOrganizationStore();
}

export async function changeSessionOrganization(change: SessionOrganizationChange) {
  const request = sequence;
  const snapshot = await window.electron.changeSessionOrganization(change);
  if (request === sequence) useSessionOrganizationStore.setState(snapshot);
}
