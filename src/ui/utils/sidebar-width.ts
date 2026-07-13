export const MIN_SIDEBAR_WIDTH = 220;
export const DEFAULT_SIDEBAR_WIDTH = 250;
export const MAX_SIDEBAR_WIDTH = 420;
export const SIDEBAR_WIDTH_VERSION = 9;

export function sanitizeSidebarWidth(
  width: number | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH
): number {
  if (typeof width !== 'number' || Number.isNaN(width)) return fallback;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function restorePersistedSidebarWidth(
  width: number | undefined,
  persistedVersion: number | undefined,
  fallback = DEFAULT_SIDEBAR_WIDTH
): number {
  if (persistedVersion === SIDEBAR_WIDTH_VERSION) {
    return sanitizeSidebarWidth(width, fallback);
  }
  return DEFAULT_SIDEBAR_WIDTH;
}
