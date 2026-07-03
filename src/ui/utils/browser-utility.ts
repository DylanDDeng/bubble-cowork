import type { ProjectUtilityPanelTarget } from '../types';

export const STANDALONE_BROWSER_SESSION_ID = '__standalone-browser__';

// Each right-panel browser tab hosts its own single-page browser session in
// the main process. The base 'browser' tab shares the chat session id; every
// extra `browser:xxx` tab derives a scoped session id from its target.
export function getBrowserUtilitySessionId(
  chatSessionId: string | null,
  target: ProjectUtilityPanelTarget
): string {
  const base = chatSessionId ?? STANDALONE_BROWSER_SESSION_ID;
  return target === 'browser' ? base : `${base}:${target}`;
}
