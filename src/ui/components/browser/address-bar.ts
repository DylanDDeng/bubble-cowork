import { addressForDisplay } from '../../../shared/browser-address';
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

/** One line over the page: errors first, then why there is nothing to show yet. */
export function browserStatusLine(input: { localError: string | null; page: BrowserPage | null; open: boolean }): StatusLine | null {
  const error = input.localError ?? input.page?.error ?? null;
  if (error) return { text: error, tone: 'error' };
  if (!input.page) return { text: input.open ? 'No page open' : 'Starting browser...', tone: 'info' };
  if (input.page.phase === 'suspended') return { text: 'Restoring page...', tone: 'info' };
  return null;
}
