import type { CSSProperties } from 'react';

/**
 * App-logo shimmer loading mark (Codex parity).
 *
 * A dim base logo with a bright diagonal light band sweeping across it,
 * masked to the logo shape so the shine only travels inside the mark.
 * Animation + colors live in index.css (`.logo-shimmer-*`) alongside the
 * theme variables; this component only supplies geometry and the mask URL.
 */

// Same geometry as src/ui/assets/cowork-logo.svg. The mask only reads alpha,
// so the fill color here is irrelevant (black = opaque).
const LOGO_MASK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' +
  '<rect x="372" y="250" width="88" height="524" rx="4" fill="#000"/>' +
  '<rect x="564" y="250" width="88" height="524" rx="4" fill="#000"/>' +
  '<rect x="276" y="468" width="472" height="88" rx="4" fill="#000"/>' +
  '</svg>';

const LOGO_MASK_URL = `url("data:image/svg+xml;utf8,${encodeURIComponent(LOGO_MASK_SVG)}")`;

export function LogoShimmer({
  size = 56,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={`logo-shimmer-root ${className}`}
      style={{ width: size, height: size, '--logo-shimmer-mask': LOGO_MASK_URL } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        className="logo-shimmer-base"
        viewBox="0 0 1024 1024"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="372" y="250" width="88" height="524" rx="4" />
        <rect x="564" y="250" width="88" height="524" rx="4" />
        <rect x="276" y="468" width="472" height="88" rx="4" />
      </svg>
      <div className="logo-shimmer-overlay" />
    </div>
  );
}
