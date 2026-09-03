/**
 * The right-panel glyph: a window with its right pane marked. Shared by the
 * session view's panel launcher and the task detail's properties toggle so
 * "the panel on the right" reads the same everywhere.
 */
export function RightPanelToggleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="16" x="3" y="4" rx="4" />
      <path d="M15 8v8" />
    </svg>
  );
}
