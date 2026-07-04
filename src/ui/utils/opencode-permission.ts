import { rendererStateStorage } from './renderer-state-storage';
import type { OpenCodePermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredOpencodePermissionMode';

function normalizeOpenCodePermissionMode(
  raw: string | null | undefined
): OpenCodePermissionMode {
  if (raw === 'plan') {
    return 'plan';
  }

  if (raw === 'fullAccess' || raw === 'fullAuto') {
    return 'fullAccess';
  }

  return 'defaultPermissions';
}

export function loadPreferredOpencodePermissionMode(): OpenCodePermissionMode {
  if (typeof window === 'undefined') return 'defaultPermissions';
  return normalizeOpenCodePermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredOpencodePermissionMode(mode: OpenCodePermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, mode);
}
