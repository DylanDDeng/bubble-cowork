import { rendererStateStorage } from './renderer-state-storage';
import type { MimoPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredMimoPermissionMode';
const MIMO_PERMISSION_MODES: ReadonlyArray<MimoPermissionMode> = ['ask', 'build', 'plan'];

// MiMo's own `build` agent allows every tool; Aegis starts on its injected
// `ask` agent, which asks before edits, commands and web fetches.
export function normalizeMimoPermissionMode(value: unknown): MimoPermissionMode {
  return MIMO_PERMISSION_MODES.includes(value as MimoPermissionMode) ? (value as MimoPermissionMode) : 'ask';
}

export function loadPreferredMimoPermissionMode(): MimoPermissionMode {
  if (typeof window === 'undefined') return 'ask';
  return normalizeMimoPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredMimoPermissionMode(mode: MimoPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeMimoPermissionMode(mode));
}
