/**
 * Shared favicon helpers for external-link chips (markdown answers and the
 * composer). Icons come from Google's s2 favicon service; callers fall back
 * to a globe icon (matching the browser panel) when no favicon is available.
 */

export const FAVICON_REQUEST_SIZE = 32;

export function faviconUrlForHostname(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=${FAVICON_REQUEST_SIZE}`;
}

/**
 * Google's s2 service never 404s: domains without a favicon get a default
 * globe placeholder served at 16x16 regardless of the requested size, while
 * real favicons come back at the requested size. A smaller-than-requested
 * image therefore means "no favicon" and callers should show the monogram.
 */
export function isFaviconPlaceholder(img: HTMLImageElement): boolean {
  return img.naturalWidth > 0 && img.naturalWidth < FAVICON_REQUEST_SIZE;
}
