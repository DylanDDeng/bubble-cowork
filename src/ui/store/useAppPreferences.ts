import { create } from 'zustand';
import { DEFAULT_APP_PREFERENCES, type AppPreferences } from '../../shared/app-preferences';

export const useAppPreferences = create<AppPreferences>(() => ({ ...DEFAULT_APP_PREFERENCES }));
let sequence = 0;
let writes: Promise<void> = Promise.resolve();
let subscribers = 0;
let unsubscribe: (() => void) | undefined;

export async function refreshAppPreferences(): Promise<void> {
  const request = ++sequence;
  const preferences = await window.electron.getAppPreferences();
  if (request === sequence) useAppPreferences.setState(preferences);
}

export function subscribeAppPreferences(): () => void {
  if (!window.electron?.getAppPreferences) return () => {};
  if (++subscribers === 1) {
    unsubscribe = window.electron.onAppPreferencesChanged(preferences => {
      sequence++;
      useAppPreferences.setState(preferences);
    });
    void refreshAppPreferences().catch(() => {});
  }
  return () => { if (--subscribers === 0) { sequence++; unsubscribe?.(); unsubscribe = undefined; } };
}

export function saveAppPreferences(patch: Partial<AppPreferences>): Promise<void> {
  const update = writes.catch(() => {}).then(async () => {
    const request = sequence;
    const next = await window.electron.setAppPreferences(patch);
    if (request === sequence) useAppPreferences.setState(next);
  });
  writes = update;
  return update;
}
