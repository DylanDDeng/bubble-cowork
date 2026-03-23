import type { CodexPermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexPermissionMode';

function normalizeCodexPermissionMode(
  raw: string | null | undefined
): CodexPermissionMode {
  if (raw === 'fullAccess' || raw === 'fullAuto') {
    return 'fullAccess';
  }

  return 'defaultPermissions';
}

export function loadPreferredCodexPermissionMode(): CodexPermissionMode {
  if (typeof window === 'undefined') return 'defaultPermissions';
  return normalizeCodexPermissionMode(window.localStorage.getItem(STORAGE_KEY));
}

export function savePreferredCodexPermissionMode(mode: CodexPermissionMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, mode);
}
