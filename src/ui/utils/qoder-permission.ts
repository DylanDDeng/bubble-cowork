import { rendererStateStorage } from './renderer-state-storage';
import type { QoderPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredQoderPermissionMode';

export function normalizeQoderPermissionMode(value: unknown): QoderPermissionMode {
  return value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'yolo' ||
    value === 'plan' ||
    value === 'dontAsk' ||
    value === 'auto'
    ? value
    : 'default';
}

export function loadPreferredQoderPermissionMode(): QoderPermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeQoderPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredQoderPermissionMode(mode: QoderPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeQoderPermissionMode(mode));
}
