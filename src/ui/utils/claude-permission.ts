import type { ClaudePermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudePermissionMode';

export function normalizeClaudePermissionMode(value: unknown): ClaudePermissionMode {
  switch (typeof value === 'string' ? value.trim() : '') {
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return value as ClaudePermissionMode;
    case 'fullAccess':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

export function loadPreferredClaudePermissionMode(): ClaudePermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeClaudePermissionMode(window.localStorage.getItem(STORAGE_KEY));
}

export function savePreferredClaudePermissionMode(mode: ClaudePermissionMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, normalizeClaudePermissionMode(mode));
}
