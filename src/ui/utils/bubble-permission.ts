import { rendererStateStorage } from './renderer-state-storage';
import type { BubblePermissionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredBubblePermissionMode';

// Composer-preference normalizer. Deliberately does NOT accept 'plan': plan is
// an execution-mode toggle (/plan + pill, Claude-style), never a persisted
// permission preference — a stale stored 'plan' must come back as 'default'.
export function normalizeBubblePermissionMode(value: unknown): BubblePermissionMode {
  return value === 'bypassPermissions' ? value : 'default';
}

export function loadPreferredBubblePermissionMode(): BubblePermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeBubblePermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredBubblePermissionMode(mode: BubblePermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeBubblePermissionMode(mode));
}
