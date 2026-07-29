/**
 * Custom toolbar glyphs shared by the diff surfaces (pull-request review and
 * the changes panel), drawn to match the codex app's toolbar.
 */

/**
 * Split-diff toggle glyph: an outlined square whose halves carry the
 * deletion/addition tints. Outline follows currentColor so the active state
 * still reads from the button's text color.
 */
export function SplitDiffGlyph({ className }: { className?: string }) {
  // Drawn on tabler's 24px grid with its stroke conventions so the line
  // weight and antialiasing match the sibling toolbar icons exactly.
  // Opaque fills only: translucent color composites against the hover
  // background and reads as "darker on hover".
  // Every paint is a fixed opaque hex and the svg opts out of transitions:
  // no currentColor, no CSS variables — nothing the hover state can touch.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#9aa1ac"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ transition: 'none' }}
      aria-hidden="true"
    >
      <rect x="5.5" y="6.5" width="5.5" height="11" rx="1" fill="#fca5a5" stroke="none" />
      <rect x="13" y="6.5" width="5.5" height="11" rx="1" fill="#86efac" stroke="none" />
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    </svg>
  );
}

/**
 * Horizontal git-commit glyph (a commit node on a branch line). Tabler only
 * ships the vertical variant; the toolbar wants the horizontal one.
 */
export function GitCommitHorizontalGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M2.5 12h6.5" />
      <path d="M15 12h6.5" />
    </svg>
  );
}

/**
 * Expand/collapse-all glyph: an up-down arrow on the left with two list
 * lines on the right. Tabler's 24px grid and stroke conventions so it sits
 * flush with the sibling icons.
 */
export function ExpandAllGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 4v5" />
      <path d="M4.5 6.5 7 9l2.5-2.5" />
      <path d="M7 20v-5" />
      <path d="M4.5 17.5 7 15l2.5 2.5" />
      <path d="M13.5 9h7" />
      <path d="M13.5 15h4.5" />
    </svg>
  );
}
