import type { OpenCodePermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredOpencodePermissionMode';

function normalizeOpenCodePermissionMode(
  raw: string | null | undefined
): OpenCodePermissionMode {
  if (raw === 'fullAccess' || raw === 'fullAuto') {
    return 'fullAccess';
  }

  return 'defaultPermissions';
}

export function loadPreferredOpencodePermissionMode(): OpenCodePermissionMode {
  if (typeof window === 'undefined') return 'defaultPermissions';
  return normalizeOpenCodePermissionMode(window.localStorage.getItem(STORAGE_KEY));
}

export function savePreferredOpencodePermissionMode(mode: OpenCodePermissionMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, mode);
}
