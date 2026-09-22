export const RIGHT_PANEL_MIN_WIDTH = 320;
const CHAT_PANE_MIN_WIDTH = 352;

export function getDockedRightPanelMaxWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return Infinity;
  // On compact windows let the chat shrink before making the utility pane
  // unusable, but never let the pane overflow its host.
  return Math.min(availableWidth, Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth - CHAT_PANE_MIN_WIDTH));
}

/**
 * Reserve room for the conversation while retaining the preferred width, so
 * expanding the app restores the user's layout without disabling the divider.
 */
export function resolveDockedRightPanelWidth(
  preferredWidth: number,
  availableWidth: number
): number {
  const safePreferredWidth = Math.max(0, Math.round(preferredWidth));
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return safePreferredWidth;
  }

  return Math.min(safePreferredWidth, Math.floor(getDockedRightPanelMaxWidth(availableWidth)));
}
