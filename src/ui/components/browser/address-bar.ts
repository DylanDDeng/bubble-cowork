import { addressForDisplay, BLANK_PAGE } from '../../../shared/browser-address';
import type { BrowserPage } from '../../../shared/browser-types';

/**
 * The address field follows the page's address unless the user is typing:
 * while editing, page updates (redirects, title loads) must not overwrite
 * what is being typed, and switching to another page always shows that
 * page's address.
 */
export interface AddressField {
  text: string;
  editing: boolean;
  /** Page the text belongs to. */
  pageId: string | null;
  /** The page address last shown, to restore on Escape. */
  pageAddress: string;
}

export type AddressAction =
  | { kind: 'page'; page: BrowserPage | null }
  | { kind: 'type'; text: string }
  | { kind: 'focus' }
  | { kind: 'blur' }
  | { kind: 'cancel' }
  | { kind: 'submitted' };

export const emptyAddressField: AddressField = { text: '', editing: false, pageId: null, pageAddress: '' };

export function updateAddressField(field: AddressField, action: AddressAction): AddressField {
  switch (action.kind) {
    case 'page': {
      const pageId = action.page?.id ?? null;
      const pageAddress = addressForDisplay(action.page?.url);
      if (pageId !== field.pageId) return { text: pageAddress, editing: false, pageId, pageAddress };
      if (pageAddress === field.pageAddress) return field;
      return field.editing ? { ...field, pageAddress } : { ...field, text: pageAddress, pageAddress };
    }
    case 'type':
      return { ...field, text: action.text, editing: true };
    case 'focus':
      return field.editing ? field : { ...field, editing: true };
    case 'blur':
      return field.editing ? { ...field, editing: false } : field;
    case 'submitted':
      // Show the page's address now: the navigation's own state push may
      // already have arrived while the field was still being edited.
      return { ...field, text: field.pageAddress, editing: false };
    case 'cancel':
      return { ...field, text: field.pageAddress, editing: false };
  }
}

export interface StatusLine {
  text: string;
  tone: 'info' | 'error';
}

/**
 * A small line over the page for what the page itself can't show: a failed
 * panel request, or why there is nothing to show yet. Load errors get the
 * full error view instead (see pageOverlayFor).
 */
export function browserStatusLine(input: { localError: string | null; page: BrowserPage | null; open: boolean }): StatusLine | null {
  if (input.localError) return { text: input.localError, tone: 'error' };
  if (!input.page) return { text: input.open ? 'No page open' : 'Starting browser...', tone: 'info' };
  if (input.page.phase === 'suspended' && !input.page.error && input.page.url !== BLANK_PAGE) {
    return { text: 'Restoring page...', tone: 'info' };
  }
  return null;
}

/**
 * What the panel draws instead of the page: a start view for a blank page,
 * an explanation for one that failed. The native page is taken off screen
 * while either shows (it would cover them).
 */
export type PageOverlay = 'empty' | 'error' | null;

export function pageOverlayFor(page: BrowserPage | null, agentActive: boolean): PageOverlay {
  if (!page || page.loading) return null;
  if (page.error) return 'error';
  // An agent may be about to navigate a blank page; let it be seen.
  if (!agentActive && (!page.url || page.url === BLANK_PAGE)) return 'empty';
  return null;
}

/** The address bar's leading mark. */
export type SiteMark = 'favicon' | 'error' | 'file' | 'search' | 'web';

export function siteMarkFor(page: BrowserPage | null): SiteMark {
  if (!page || !page.url || page.url === BLANK_PAGE) return 'search';
  if (page.error) return 'error';
  if (page.url.startsWith('file:')) return 'file';
  return page.favicon && /^(https?:|data:image\/)/.test(page.favicon) ? 'favicon' : 'web';
}

/** Pages other browser tabs showed last, newest first, for the start view. */
export function recentPages(
  pages: Record<string, { url: string; title: string; favicon: string | null; seenAt: number }>,
  excludeSessionId: string,
  limit = 5
): Array<{ url: string; title: string; favicon: string | null }> {
  const seen = new Set<string>();
  return Object.entries(pages)
    .filter(([sessionId, page]) => sessionId !== excludeSessionId && /^(https?|file):/.test(page.url))
    .sort((a, b) => b[1].seenAt - a[1].seenAt)
    .flatMap(([, page]) => {
      if (seen.has(page.url)) return [];
      seen.add(page.url);
      return [{ url: page.url, title: page.title, favicon: page.favicon }];
    })
    .slice(0, limit);
}

/** Shortcuts the panel takes while its own controls have focus. */
export type PanelShortcut = 'focus-address' | 'find' | 'back' | 'forward';

export function panelShortcutFor(
  event: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean
): PanelShortcut | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey || event.shiftKey) return null;
  const code = event.code || '';
  if (code === 'KeyL' || (!code && event.key.toLowerCase() === 'l')) return 'focus-address';
  if (code === 'KeyF' || (!code && event.key.toLowerCase() === 'f')) return 'find';
  if (code === 'BracketLeft') return 'back';
  if (code === 'BracketRight') return 'forward';
  return null;
}
