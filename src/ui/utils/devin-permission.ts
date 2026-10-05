import { rendererStateStorage } from './renderer-state-storage';
import type { DevinPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredDevinPermissionMode';
const DEVIN_PERMISSION_MODES: ReadonlyArray<DevinPermissionMode> = ['accept-edits', 'smart', 'ask', 'plan', 'bypass'];

export function normalizeDevinPermissionMode(value: unknown): DevinPermissionMode {
  return DEVIN_PERMISSION_MODES.includes(value as DevinPermissionMode)
    ? (value as DevinPermissionMode)
    : 'accept-edits';
}

export function loadPreferredDevinPermissionMode(): DevinPermissionMode {
  if (typeof window === 'undefined') return 'accept-edits';
  return normalizeDevinPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredDevinPermissionMode(mode: DevinPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeDevinPermissionMode(mode));
}
