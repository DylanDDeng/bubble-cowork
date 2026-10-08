// In-app browser types shared by the main process and the renderer. Each
// browser session (a chat's browser utility tab) shows exactly one page.

export const BROWSER_SESSION_PARTITION = 'persist:coworker-browser';

/** `live` has a renderer process; `suspended` keeps only the address to restore. */
export type BrowserPagePhase = 'live' | 'suspended';

export interface BrowserPage {
  /** Stable for the life of the session's page; agents and design mode address it. */
  id: string;
  url: string;
  title: string;
  phase: BrowserPagePhase;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  favicon: string | null;
  /** The address Chromium last committed, used to restore a suspended page. */
  committedUrl: string | null;
  /** User-facing reason the last load failed, cleared by the next navigation. */
  error: string | null;
}

export interface BrowserSessionState {
  sessionId: string;
  open: boolean;
  page: BrowserPage | null;
  /** True while browser_use drives the page, so the panel can show who is in control. */
  agentActive: boolean;
}

/** Window-relative rectangle the native page view is laid over. */
export interface BrowserViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ===== IPC inputs =====

export interface BrowserSessionInput {
  sessionId: string;
}

export interface BrowserOpenInput extends BrowserSessionInput {
  initialUrl?: string;
}

export interface BrowserNavigateInput extends BrowserSessionInput {
  url: string;
}

export interface BrowserViewportInput extends BrowserSessionInput {
  viewport: BrowserViewport | null;
}

// ===== Screenshot and page readout =====

export interface BrowserCapturePageResult {
  ok: boolean;
  message?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  base64?: string;
  pageUrl?: string;
  pageTitle?: string;
}

export interface BrowserReadoutLink {
  url: string;
  text: string;
}

export interface BrowserReadoutResult {
  ok: boolean;
  message?: string;
  url?: string;
  title?: string;
  text?: string;
  selection?: string;
  links?: BrowserReadoutLink[];
}

/** "Send selection to chat" from the page's context menu. */
export interface BrowserSendSelectionEvent {
  sessionId: string;
  pageId: string;
  selectionText: string;
  pageUrl: string;
  pageTitle: string;
}
