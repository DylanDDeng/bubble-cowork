import { randomUUID } from 'node:crypto';
import { BLANK_PAGE, placeholderTitle } from '../../shared/browser-address';
import type { BrowserPage, BrowserSessionState } from '../../shared/browser-types';

/**
 * Page and session bookkeeping for the in-app browser, without Electron:
 * the manager feeds in what the native view reports and these functions
 * keep the shared state consistent.
 */

/** What a live view reports about itself. */
export interface ViewFacts {
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  favicons?: string[];
}

export function blankSession(sessionId: string): BrowserSessionState {
  return { sessionId, open: false, page: null, agentActive: false };
}

export function newPage(url: string = BLANK_PAGE): BrowserPage {
  return {
    id: randomUUID(),
    url,
    title: placeholderTitle(url),
    phase: 'suspended',
    loading: false,
    canBack: false,
    canForward: false,
    favicon: null,
    committedUrl: null,
    error: null,
  };
}

export function copySession(session: BrowserSessionState): BrowserSessionState {
  return { ...session, page: session.page ? { ...session.page } : null };
}

/** Points the page at a new address; what was committed before no longer applies. */
export function retarget(page: BrowserPage, url: string): void {
  page.url = url;
  page.title = placeholderTitle(url);
  page.committedUrl = null;
  page.error = null;
}

/** The renderer process is gone; keep only what is needed to restore the page. */
export function suspend(page: BrowserPage): void {
  page.phase = 'suspended';
  page.loading = false;
  page.canBack = false;
  page.canForward = false;
}

/**
 * Takes in a view's report. An error stays until a new navigation starts
 * (see `navigationStarted`), so a failed load keeps explaining itself after
 * the load stops.
 */
export function absorb(page: BrowserPage, facts: ViewFacts): void {
  page.phase = 'live';
  if (facts.url) {
    page.url = facts.url;
    page.committedUrl = facts.url;
  }
  page.title = facts.title && facts.title !== BLANK_PAGE ? facts.title : placeholderTitle(page.url);
  page.loading = facts.loading;
  page.canBack = facts.canBack;
  page.canForward = facts.canForward;
  if (facts.favicons) page.favicon = facts.favicons[0] ?? page.favicon;
}

export function navigationStarted(page: BrowserPage): void {
  page.phase = 'live';
  page.loading = true;
  page.error = null;
}

export function loadFailed(page: BrowserPage, message: string, url?: string): void {
  if (url) {
    page.url = url;
    page.title = placeholderTitle(url);
  }
  page.loading = false;
  page.error = message;
}

const LOAD_FAILURES: Record<number, string> = {
  [-102]: 'Connection refused.',
  [-105]: "Couldn't resolve this address.",
  [-106]: "You're offline.",
  [-118]: 'This page took too long to respond.',
  [-137]: "A secure connection couldn't be established.",
  [-200]: "A secure connection couldn't be established.",
};

export const GENERIC_LOAD_FAILURE = "Couldn't open this page.";

/** Chromium net error code → message for the panel. */
export function describeLoadFailure(code: number): string {
  return LOAD_FAILURES[code] ?? GENERIC_LOAD_FAILURE;
}
