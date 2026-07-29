/**
 * Shared favicon helpers for external-link chips (markdown answers and the
 * composer). Icons come from Google's s2 favicon service; callers fall back
 * to a hostname monogram when the fetch fails.
 */

export function faviconUrlForHostname(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
}

export function hostnameMonogram(hostname: string): string {
  const base = hostname.split('.')[0] || hostname;
  const letter = base.charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(letter) ? letter : '?';
}
