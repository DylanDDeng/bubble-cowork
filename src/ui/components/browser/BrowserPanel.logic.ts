// Address bar sync rules and navigation normalization for the in-app browser.
// Ported from dpcode (Emanuele-web04/dpcode) BrowserPanel.logic.ts.

import type { BrowserTabState } from '../../../shared/browser-types';

const ABOUT_BLANK_URL = 'about:blank';
const SEARCH_URL_PREFIX = 'https://www.google.com/search?q=';

interface ResolveBrowserAddressSyncInput {
  activeTabId: string | null;
  previousActiveTabId: string | null;
  savedDraft: string | undefined;
  nextDisplayValue: string;
  lastSyncedValue: string | undefined;
  isEditing: boolean;
}

type BrowserAddressSyncDecision =
  | { type: 'keep' }
  | { type: 'replace'; value: string; syncedValue: string | undefined };

export interface BrowserChromeStatus {
  tone: 'default' | 'error';
  label: string;
}

export function browserAddressDisplayValue(
  tab: Pick<BrowserTabState, 'url'> | null | undefined
): string {
  const nextUrl = tab?.url?.trim() ?? '';
  return nextUrl === ABOUT_BLANK_URL ? '' : nextUrl;
}

function looksLikeUrlInput(value: string): boolean {
  return (
    value.includes('.') ||
    value.startsWith('localhost') ||
    value.startsWith('127.0.0.1') ||
    value.startsWith('0.0.0.0') ||
    value.startsWith('[::1]')
  );
}

export function normalizeBrowserAddressInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return ABOUT_BLANK_URL;
  try {
    const withScheme = new URL(trimmed);
    if (withScheme.protocol === 'http:' || withScheme.protocol === 'https:') {
      return withScheme.toString();
    }
    if (withScheme.protocol === 'about:') {
      return withScheme.toString();
    }
  } catch {
    // fall through
  }
  if (trimmed.includes(' ')) {
    return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
  }
  if (looksLikeUrlInput(trimmed)) {
    const prefersHttp =
      trimmed.startsWith('localhost') ||
      trimmed.startsWith('127.0.0.1') ||
      trimmed.startsWith('0.0.0.0') ||
      trimmed.startsWith('[::1]');
    const scheme = prefersHttp ? 'http' : 'https';
    try {
      return new URL(`${scheme}://${trimmed}`).toString();
    } catch {
      return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
    }
  }
  return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
}

export function resolveBrowserChromeStatus(input: {
  localError: string | null;
  sessionLastError: string | null | undefined;
  activeTabStatus: string;
  hasActiveTab: boolean;
  workspaceReady: boolean;
}): BrowserChromeStatus | null {
  if (input.localError) return { tone: 'error', label: input.localError };
  if (input.sessionLastError) return { tone: 'error', label: input.sessionLastError };
  if (!input.hasActiveTab) {
    return {
      tone: 'default',
      label: input.workspaceReady ? 'No page open' : 'Starting browser...',
    };
  }
  if (input.activeTabStatus === 'suspended') {
    return { tone: 'default', label: 'Restoring page...' };
  }
  return null;
}

export function resolveBrowserAddressSync(
  input: ResolveBrowserAddressSyncInput
): BrowserAddressSyncDecision {
  if (!input.activeTabId) {
    return { type: 'replace', value: '', syncedValue: undefined };
  }
  if (input.activeTabId !== input.previousActiveTabId) {
    if (input.savedDraft !== undefined) {
      return {
        type: 'replace',
        value: input.savedDraft,
        syncedValue: input.lastSyncedValue,
      };
    }
    return {
      type: 'replace',
      value: input.nextDisplayValue,
      syncedValue: input.nextDisplayValue,
    };
  }
  if (input.isEditing || input.lastSyncedValue === input.nextDisplayValue) {
    return { type: 'keep' };
  }
  return {
    type: 'replace',
    value: input.nextDisplayValue,
    syncedValue: input.nextDisplayValue,
  };
}
