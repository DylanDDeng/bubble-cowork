/**
 * Turns what someone typed into the browser's address bar into a URL. Shared
 * by the renderer (to show what will load) and the main process (which also
 * validates local files).
 *
 * - empty → about:blank
 * - http(s), about: and file: URLs are kept (file: is checked by the main process)
 * - a single word that names a host (dotted name, IPv4, localhost, [::1]),
 *   optionally with port and path, gets a scheme: http for loopback, https otherwise
 * - anything else becomes a web search
 */

export const BLANK_PAGE = 'about:blank';
export const WEB_SEARCH_PREFIX = 'https://www.google.com/search?q=';

const KEPT_SCHEMES = new Set(['http:', 'https:', 'about:', 'file:']);
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// A dotted host name whose last label looks like a top-level domain.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

export function webSearchUrl(text: string): string {
  return WEB_SEARCH_PREFIX + encodeURIComponent(text);
}

function explicitUrl(text: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  try {
    const url = new URL(text);
    return KEPT_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The host part of a bare address like `example.com:8080/path`, without the port. */
function bareHost(text: string): string {
  const authority = text.split(/[/?#]/, 1)[0];
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  return authority.replace(/:\d+$/, '');
}

export function resolveAddress(input: string | null | undefined): string {
  const text = (input ?? '').trim();
  if (!text) return BLANK_PAGE;
  const explicit = explicitUrl(text);
  if (explicit) return explicit;
  if (/\s/.test(text)) return webSearchUrl(text);

  const host = bareHost(text);
  const loopback = LOOPBACK.test(host);
  if (loopback || IPV4.test(host) || DOMAIN.test(host)) {
    try {
      return new URL(`${loopback ? 'http' : 'https'}://${text}`).href;
    } catch {
      // Not a valid authority after all.
    }
  }
  return webSearchUrl(text);
}

/** The address bar shows nothing for a blank page. */
export function addressForDisplay(url: string | null | undefined): string {
  const trimmed = (url ?? '').trim();
  return trimmed === BLANK_PAGE ? '' : trimmed;
}

/** Tab label for a page: its host, or the URL itself when it has none. */
export function placeholderTitle(url: string): string {
  if (url === BLANK_PAGE) return 'New page';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
