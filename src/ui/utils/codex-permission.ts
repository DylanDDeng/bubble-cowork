import { rendererStateStorage } from './renderer-state-storage';
import type { CodexPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexPermissionMode';

export function normalizeCodexPermissionMode(
  raw: string | null | undefined
): CodexPermissionMode {
  if (raw === 'fullAccess' || raw === 'fullAuto') {
    return 'fullAccess';
  }
  if (raw === 'auto' || raw === 'autoReview') {
    return 'auto';
  }

  return 'defaultPermissions';
}

export function loadPreferredCodexPermissionMode(): CodexPermissionMode {
  if (typeof window === 'undefined') return 'defaultPermissions';
  return normalizeCodexPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredCodexPermissionMode(mode: CodexPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeCodexPermissionMode(mode));
}
