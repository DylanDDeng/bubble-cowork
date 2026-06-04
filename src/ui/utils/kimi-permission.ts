import type { KimiPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredKimiPermissionMode';

export function normalizeKimiPermissionMode(value: unknown): KimiPermissionMode {
  return value === 'plan' || value === 'auto' || value === 'yolo' ? value : 'default';
}

export function loadPreferredKimiPermissionMode(): KimiPermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeKimiPermissionMode(window.localStorage.getItem(STORAGE_KEY));
}

export function savePreferredKimiPermissionMode(mode: KimiPermissionMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, normalizeKimiPermissionMode(mode));
}
