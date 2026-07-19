import { rendererStateStorage } from './renderer-state-storage';
import type { KimiPermissionMode, KimiThinking } from '../types';

const STORAGE_KEY = 'cowork.preferredKimiPermissionMode';
const THINKING_STORAGE_KEY = 'cowork.preferredKimiThinking';

export function normalizeKimiPermissionMode(value: unknown): KimiPermissionMode {
  return value === 'plan' || value === 'auto' || value === 'yolo' ? value : 'default';
}

export function loadPreferredKimiPermissionMode(): KimiPermissionMode {
  if (typeof window === 'undefined') return 'default';
  return normalizeKimiPermissionMode(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredKimiPermissionMode(mode: KimiPermissionMode): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeKimiPermissionMode(mode));
}

/**
 * Effort tiers are an OPEN per-model set (k2.x: on/off; k3-class:
 * off/low/high/max per `support_efforts`) — never whitelist tiers here. An
 * empty/absent preference means "use the server's per-model default".
 */
export function normalizeKimiThinking(value: unknown): KimiThinking | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function loadPreferredKimiThinking(): KimiThinking | null {
  if (typeof window === 'undefined') return null;
  return normalizeKimiThinking(rendererStateStorage.getItem(THINKING_STORAGE_KEY));
}

export function savePreferredKimiThinking(value: KimiThinking | null): void {
  if (typeof window === 'undefined') return;
  if (value === null) {
    // "Default" selection: no explicit tier is sent; the server applies the
    // model's own default.
    rendererStateStorage.removeItem(THINKING_STORAGE_KEY);
    return;
  }
  const normalized = normalizeKimiThinking(value);
  if (normalized) {
    rendererStateStorage.setItem(THINKING_STORAGE_KEY, normalized);
  }
}
