const DOCKED_RIGHT_PANEL_MAX_RATIO = 0.58;

/**
 * Keep a docked utility panel visibly attached to the right side instead of
 * letting a desktop-sized saved width consume a compact window. The preferred
 * width remains untouched, so expanding the app restores the user's layout.
 */
export function resolveDockedRightPanelWidth(
  preferredWidth: number,
  availableWidth: number
): number {
  const safePreferredWidth = Math.max(0, Math.round(preferredWidth));
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return safePreferredWidth;
  }

  return Math.min(
    safePreferredWidth,
    Math.max(0, Math.floor(availableWidth * DOCKED_RIGHT_PANEL_MAX_RATIO))
  );
}
