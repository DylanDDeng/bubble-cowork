import { rendererStateStorage } from './renderer-state-storage';
import type { DeepseekPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredDeepseekPermissionMode';

export function normalizeDeepseekPermissionMode(value: unknown): DeepseekPermissionMode {
  return value === 'danger-full-access' ? 'danger-full-access' : 'workspace-write';
}

export function loadPreferredDeepseekPermissionMode(): DeepseekPermissionMode {
  if (typeof window === 'undefined') return 'workspace-write';
  return normalizeDeepseekPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredDeepseekPermissionMode(mode: DeepseekPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeDeepseekPermissionMode(mode));
}
