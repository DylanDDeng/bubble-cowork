// Per-session in-app browser manager.
//
// Based on dpcode (Emanuele-web04/dpcode) DesktopBrowserManager design but
// scoped to `sessionId` (each chat session has its own tabs + WebContentsView
// lifecycle). Adds screenshot + page readout (text / links / selection) for
// Agent integration.
//
// Key ideas:
// 1. One WebContentsView per (sessionId, tabId) while the session is active.
// 2. At most one WebContentsView is attached to the BrowserWindow at a time.
// 3. Inactive sessions are suspended after BROWSER_SESSION_SUSPEND_DELAY_MS
//    to release Chromium renderer processes.
// 4. Renderer sends panel bounds via `setPanelBounds`; main mirrors them
//    onto the attached view.

import * as Crypto from 'node:crypto';
import { BrowserWindow, Menu, clipboard, shell, WebContentsView } from 'electron';
import type {
  BrowserCapturePageResult,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserPanelBounds,
  BrowserReadoutLink,
  BrowserReadoutResult,
  BrowserSessionInput,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserTabState,
  SessionBrowserState,
} from '../shared/browser-types';

const ABOUT_BLANK_URL = 'about:blank';
const BROWSER_SESSION_PARTITION = 'persist:coworker-browser';
const BROWSER_SESSION_SUSPEND_DELAY_MS = 30_000;
const BROWSER_ERROR_ABORTED = -3;
const SEARCH_URL_PREFIX = 'https://www.google.com/search?q=';

type BrowserStateListener = (state: SessionBrowserState) => void;

export interface BrowserSendSelectionToChatEvent {
  sessionId: string;
  tabId: string;
  selectionText: string;
  pageUrl: string;
  pageTitle: string;
}

type BrowserSendSelectionListener = (event: BrowserSendSelectionToChatEvent) => void;

interface LiveTabRuntime {
  key: string;
  sessionId: string;
  tabId: string;
  view: WebContentsView;
}

function createBrowserTab(url = ABOUT_BLANK_URL): BrowserTabState {
  return {
    id: Crypto.randomUUID(),
    url,
    title: defaultTitleForUrl(url),
    status: 'suspended',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: null,
    lastError: null,
  };
}

function defaultSessionBrowserState(sessionId: string): SessionBrowserState {
  return {
    sessionId,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function cloneSessionState(state: SessionBrowserState): SessionBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function defaultTitleForUrl(url: string): string {
  if (url === ABOUT_BLANK_URL) {
    return 'New tab';
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function normalizeBounds(bounds: BrowserPanelBounds | null): BrowserPanelBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }
  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width,
    height,
  };
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

function normalizeUrlInput(input: string | undefined): string {
  const trimmed = input?.trim() ?? '';
  if (trimmed.length === 0) {
    return ABOUT_BLANK_URL;
  }
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

function isAbortedNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /ERR_ABORTED|\(-3\)/i.test(error.message);
}

function mapBrowserLoadError(errorCode: number): string {
  switch (errorCode) {
    case -102:
      return 'Connection refused.';
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return 'This page took too long to respond.';
    case -137:
      return "A secure connection couldn't be established.";
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return "Couldn't open this page.";
  }
}

function buildRuntimeKey(sessionId: string, tabId: string): string {
  return `${sessionId}:${tabId}`;
}

export class BrowserManager {
  private window: BrowserWindow | null = null;
  private activeSessionId: string | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private attachedRuntimeKey: string | null = null;
  private readonly states = new Map<string, SessionBrowserState>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly selectionListeners = new Set<BrowserSendSelectionListener>();
  private readonly suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      if (this.activeSessionId && this.activeBounds) {
        this.attachActiveTab(this.activeSessionId, this.activeBounds);
      }
      return;
    }
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSendSelection(listener: BrowserSendSelectionListener): () => void {
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.listeners.clear();
    this.selectionListeners.clear();
    this.states.clear();
    this.window = null;
    this.activeSessionId = null;
    this.activeBounds = null;
  }

  // ===== Public API =====

  open(input: BrowserOpenInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId, input.initialUrl);
    state.open = true;
    syncSessionLastError(state);

    if (
      this.activeBounds &&
      (this.activeSessionId === null || this.activeSessionId === input.sessionId)
    ) {
      this.activateSession(input.sessionId, this.activeBounds);
    }
    this.emitState(input.sessionId);
    return cloneSessionState(state);
  }

  close(input: BrowserSessionInput): SessionBrowserState {
    this.clearSuspendTimer(input.sessionId);
    if (this.activeSessionId === input.sessionId) {
      this.detachAttachedRuntime();
      this.activeSessionId = null;
    }
    this.destroySessionRuntimes(input.sessionId);
    const state = this.getOrCreateState(input.sessionId);
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.emitState(input.sessionId);
    return cloneSessionState(state);
  }

  hide(input: BrowserSessionInput): void {
    const state = this.states.get(input.sessionId);
    if (!state?.open) return;
    if (this.activeSessionId === input.sessionId) {
      this.detachAttachedRuntime();
      this.activeSessionId = null;
    }
    this.scheduleSessionSuspend(input.sessionId);
  }

  getState(input: BrowserSessionInput): SessionBrowserState {
    return cloneSessionState(this.getOrCreateState(input.sessionId));
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): SessionBrowserState {
    const state = this.getOrCreateState(input.sessionId);
    const nextBounds = normalizeBounds(input.bounds);
    this.activeBounds = nextBounds;

    if (!state.open || nextBounds === null) {
      if (this.activeSessionId === input.sessionId) {
        this.detachAttachedRuntime();
        this.activeSessionId = null;
        this.scheduleSessionSuspend(input.sessionId);
      }
      return cloneSessionState(state);
    }
    this.activateSession(input.sessionId, nextBounds);
    return cloneSessionState(state);
  }

  navigate(input: BrowserNavigateInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId);
    const tab = this.resolveTab(state, input.tabId);
    const nextUrl = normalizeUrlInput(input.url);
    tab.url = nextUrl;
    tab.title = defaultTitleForUrl(nextUrl);
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    syncSessionLastError(state);

    if (this.activeSessionId === input.sessionId) {
      const runtime = this.ensureLiveRuntime(input.sessionId, tab.id);
      this.clearSuspendTimer(input.sessionId);
      if (state.activeTabId === tab.id && this.activeBounds) {
        this.attachRuntime(runtime, this.activeBounds);
      }
      void this.loadTab(input.sessionId, tab.id, { force: true, runtime });
    }
    this.emitState(input.sessionId);
    return cloneSessionState(state);
  }

  reload(input: BrowserTabInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.sessionId, tab.id));
    if (runtime) {
      runtime.view.webContents.reload();
    } else if (this.activeSessionId === input.sessionId) {
      this.resumeSession(input.sessionId);
      void this.loadTab(input.sessionId, tab.id, { force: true });
    }
    return cloneSessionState(state);
  }

  goBack(input: BrowserTabInput): SessionBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.sessionId, input.tabId));
    if (runtime && runtime.view.webContents.canGoBack()) {
      runtime.view.webContents.goBack();
    }
    return this.getState({ sessionId: input.sessionId });
  }

  goForward(input: BrowserTabInput): SessionBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.sessionId, input.tabId));
    if (runtime && runtime.view.webContents.canGoForward()) {
      runtime.view.webContents.goForward();
    }
    return this.getState({ sessionId: input.sessionId });
  }

  newTab(input: BrowserNewTabInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId);
    const tab = createBrowserTab(normalizeUrlInput(input.url));
    state.tabs = [...state.tabs, tab];
    if (input.activate !== false || !state.activeTabId) {
      state.activeTabId = tab.id;
    }

    if (this.activeSessionId === input.sessionId) {
      this.resumeSession(input.sessionId);
      if (state.activeTabId === tab.id && this.activeBounds) {
        this.ensureLiveRuntime(input.sessionId, tab.id);
        void this.loadTab(input.sessionId, tab.id, { force: true });
        this.attachActiveTab(input.sessionId, this.activeBounds);
      }
    } else {
      tab.status = 'suspended';
    }

    syncSessionLastError(state);
    this.emitState(input.sessionId);
    return cloneSessionState(state);
  }

  closeTab(input: BrowserTabInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return cloneSessionState(state);
    }

    this.destroyRuntime(input.sessionId, input.tabId);
    state.tabs = nextTabs;

    if (nextTabs.length === 0) {
      state.open = false;
      state.activeTabId = null;
      state.lastError = null;
      if (this.activeSessionId === input.sessionId) {
        this.detachAttachedRuntime();
        this.activeSessionId = null;
      }
      this.emitState(input.sessionId);
      return cloneSessionState(state);
    }

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)]?.id ?? null;
    }

    if (this.activeSessionId === input.sessionId && this.activeBounds) {
      this.attachActiveTab(input.sessionId, this.activeBounds);
    }

    syncSessionLastError(state);
    this.emitState(input.sessionId);
    return cloneSessionState(state);
  }

  selectTab(input: BrowserTabInput): SessionBrowserState {
    const state = this.ensureWorkspace(input.sessionId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncSessionLastError(state);
      this.emitState(input.sessionId);
    }
    if (this.activeSessionId === input.sessionId) {
      this.resumeSession(input.sessionId);
      if (this.activeBounds) {
        this.attachActiveTab(input.sessionId, this.activeBounds);
      }
    }
    return cloneSessionState(state);
  }

  openDevTools(input: BrowserTabInput): void {
    const state = this.ensureWorkspace(input.sessionId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncSessionLastError(state);
      this.emitState(input.sessionId);
    }
    this.resumeSession(input.sessionId);
    const runtime = this.ensureLiveRuntime(input.sessionId, tab.id);
    if (this.activeBounds) {
      this.attachActiveTab(input.sessionId, this.activeBounds);
    }
    runtime.view.webContents.openDevTools({ mode: 'detach' });
  }

  // ===== Screenshot / Readout for Agent =====

  async capturePage(input: BrowserTabInput): Promise<BrowserCapturePageResult> {
    const state = this.states.get(input.sessionId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(input.sessionId, input.tabId));
    if (!state || !tab || !runtime || runtime.view.webContents.isDestroyed()) {
      return { ok: false, message: 'This tab is not active right now.' };
    }
    try {
      const image = await runtime.view.webContents.capturePage();
      if (image.isEmpty()) {
        return { ok: false, message: 'Captured image is empty.' };
      }
      const size = image.getSize();
      const buffer = image.toPNG();
      const base64 = buffer.toString('base64');
      return {
        ok: true,
        dataUrl: `data:image/png;base64,${base64}`,
        mimeType: 'image/png',
        width: size.width,
        height: size.height,
        base64,
        pageUrl: runtime.view.webContents.getURL() || tab.url,
        pageTitle: runtime.view.webContents.getTitle() || tab.title,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async readPageContent(input: BrowserTabInput): Promise<BrowserReadoutResult> {
    const state = this.states.get(input.sessionId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(input.sessionId, input.tabId));
    if (!state || !tab || !runtime || runtime.view.webContents.isDestroyed()) {
      return { ok: false, message: 'This tab is not active right now.' };
    }

    // Run in the page context; strip scripts/styles, gather visible text,
    // current selection, and up to 80 meaningful links.
    const script = `(() => {
      function stripHidden(root) {
        const hidden = root.querySelectorAll('script, style, noscript, template, iframe');
        for (const el of hidden) el.remove();
      }
      const doc = document.cloneNode(true);
      stripHidden(doc);
      const body = doc.body || doc.documentElement;
      const rawText = (body ? body.innerText : '') || '';
      const text = rawText.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      const seen = new Set();
      const links = [];
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        const href = a.href;
        if (!href) continue;
        if (!/^https?:/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const label = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
        links.push({ url: href, text: label.slice(0, 200) });
        if (links.length >= 80) break;
      }
      const sel = (window.getSelection && window.getSelection()?.toString()) || '';
      return {
        url: location.href,
        title: document.title || '',
        text: text.slice(0, 20000),
        selection: sel.slice(0, 8000),
        links,
      };
    })();`;

    try {
      const result = (await runtime.view.webContents.executeJavaScript(script, true)) as {
        url: string;
        title: string;
        text: string;
        selection: string;
        links: BrowserReadoutLink[];
      };
      return {
        ok: true,
        url: result.url,
        title: result.title,
        text: result.text,
        selection: result.selection,
        links: result.links,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ===== Internals =====

  private activateSession(sessionId: string, bounds: BrowserPanelBounds): void {
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      this.scheduleSessionSuspend(this.activeSessionId);
    }
    this.activeSessionId = sessionId;
    this.activeBounds = bounds;
    this.resumeSession(sessionId);
    this.attachActiveTab(sessionId, bounds);
  }

  private resumeSession(sessionId: string): void {
    const state = this.ensureWorkspace(sessionId);
    if (!state.open) return;
    this.clearSuspendTimer(sessionId);
    const activeTab = this.getActiveTab(state);
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) continue;
      const runtime = this.ensureLiveRuntime(sessionId, tab.id);
      if (tab.status === 'suspended') {
        void this.loadTab(sessionId, tab.id, { force: true, runtime });
      } else {
        syncTabStateFromRuntime(state, tab, runtime.view.webContents);
      }
    }
    syncSessionLastError(state);
    this.emitState(sessionId);
  }

  private scheduleSessionSuspend(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state?.open || this.activeSessionId === sessionId) return;
    this.clearSuspendTimer(sessionId);
    const timer = setTimeout(() => {
      this.suspendSession(sessionId);
      this.suspendTimers.delete(sessionId);
    }, BROWSER_SESSION_SUSPEND_DELAY_MS);
    timer.unref();
    this.suspendTimers.set(sessionId, timer);
  }

  private suspendSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || this.activeSessionId === sessionId) return;
    for (const tab of state.tabs) {
      this.destroyRuntime(sessionId, tab.id);
      tab.status = 'suspended';
      tab.isLoading = false;
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
    syncSessionLastError(state);
    this.emitState(sessionId);
  }

  private clearSuspendTimer(sessionId: string): void {
    const existing = this.suspendTimers.get(sessionId);
    if (!existing) return;
    clearTimeout(existing);
    this.suspendTimers.delete(sessionId);
  }

  private attachActiveTab(sessionId: string, bounds: BrowserPanelBounds): void {
    const state = this.ensureWorkspace(sessionId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) return;
    const runtime = this.ensureLiveRuntime(sessionId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (activeTab.status === 'suspended') {
      void this.loadTab(sessionId, activeTab.id, { force: true, runtime });
    } else {
      this.syncRuntimeState(sessionId, activeTab.id);
    }
  }

  private attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.window;
    if (!window) return;
    if (this.attachedRuntimeKey === runtime.key) {
      runtime.view.setBounds(bounds);
      return;
    }
    this.detachAttachedRuntime();
    window.contentView.addChildView(runtime.view);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      return;
    }
    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime) {
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
  }

  private ensureLiveRuntime(sessionId: string, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(sessionId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = this.createLiveRuntime(sessionId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(sessionId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      tab.status = 'live';
      tab.lastError = null;
      syncSessionLastError(state);
    }
    return runtime;
  }

  private createLiveRuntime(sessionId: string, tabId: string): LiveTabRuntime {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const runtime: LiveTabRuntime = {
      key: buildRuntimeKey(sessionId, tabId),
      sessionId,
      tabId,
      view,
    };
    const webContents = view.webContents;

    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://') || url === ABOUT_BLANK_URL) {
        this.newTab({ sessionId, url, activate: true });
        if (this.activeSessionId === sessionId && this.activeBounds) {
          this.attachActiveTab(sessionId, this.activeBounds);
        }
        return { action: 'deny' };
      }
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      this.syncRuntimeState(sessionId, tabId);
    });
    webContents.on('page-favicon-updated', (_event, faviconUrls) => {
      this.syncRuntimeState(sessionId, tabId, faviconUrls);
    });
    webContents.on('did-start-loading', () => {
      this.syncRuntimeState(sessionId, tabId);
    });
    webContents.on('did-stop-loading', () => {
      this.syncRuntimeState(sessionId, tabId);
    });
    webContents.on('did-navigate', () => {
      this.syncRuntimeState(sessionId, tabId);
    });
    webContents.on('did-navigate-in-page', () => {
      this.syncRuntimeState(sessionId, tabId);
    });
    webContents.on(
      'did-fail-load',
      (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === BROWSER_ERROR_ABORTED) return;
        const state = this.states.get(sessionId);
        const tab = state ? this.getTab(state, tabId) : null;
        if (!state || !tab) return;
        tab.url = validatedURL || tab.url;
        tab.title = defaultTitleForUrl(tab.url);
        tab.isLoading = false;
        tab.lastError = mapBrowserLoadError(errorCode);
        syncSessionLastError(state);
        this.emitState(sessionId);
      }
    );
    webContents.on('context-menu', (_event, params) => {
      this.handleContextMenu(sessionId, tabId, params);
    });

    webContents.on('render-process-gone', () => {
      const state = this.states.get(sessionId);
      const tab = state ? this.getTab(state, tabId) : null;
      this.destroyRuntime(sessionId, tabId);
      if (state && tab) {
        tab.status = 'suspended';
        tab.isLoading = false;
        tab.lastError = 'This tab stopped unexpectedly.';
        syncSessionLastError(state);
        this.emitState(sessionId);
      }
      if (this.activeSessionId === sessionId && this.activeBounds) {
        this.attachActiveTab(sessionId, this.activeBounds);
      }
    });

    return runtime;
  }

  private async loadTab(
    sessionId: string,
    tabId: string,
    options: { force?: boolean; runtime?: LiveTabRuntime } = {}
  ): Promise<void> {
    const state = this.ensureWorkspace(sessionId);
    const tab = this.getTab(state, tabId);
    if (!tab) return;

    const runtime = options.runtime ?? this.ensureLiveRuntime(sessionId, tabId);
    const webContents = runtime.view.webContents;
    const nextUrl = normalizeUrlInput(
      options.force === true ? tab.url : (tab.lastCommittedUrl ?? tab.url)
    );
    const currentUrl = webContents.getURL();
    const shouldLoad = options.force === true || currentUrl !== nextUrl || currentUrl.length === 0;

    if (!shouldLoad) {
      this.syncRuntimeState(sessionId, tabId);
      return;
    }

    tab.url = nextUrl;
    tab.status = 'live';
    tab.isLoading = true;
    tab.lastError = null;
    syncSessionLastError(state);
    this.emitState(sessionId);

    try {
      await webContents.loadURL(nextUrl);
      this.syncRuntimeState(sessionId, tabId);
    } catch (error) {
      if (isAbortedNavigationError(error)) {
        this.syncRuntimeState(sessionId, tabId);
        return;
      }
      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncSessionLastError(state);
      this.emitState(sessionId);
    }
  }

  private syncRuntimeState(sessionId: string, tabId: string, faviconUrls?: string[]): void {
    const state = this.states.get(sessionId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(sessionId, tabId));
    if (!state || !tab || !runtime) return;
    syncTabStateFromRuntime(state, tab, runtime.view.webContents, faviconUrls);
    syncSessionLastError(state);
    this.emitState(sessionId);
  }

  private destroySessionRuntimes(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    for (const tab of state.tabs) {
      this.destroyRuntime(sessionId, tab.id);
    }
  }

  private destroyAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      this.destroyRuntime(runtime.sessionId, runtime.tabId);
    }
  }

  private destroyRuntime(sessionId: string, tabId: string): void {
    const key = buildRuntimeKey(sessionId, tabId);
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    if (this.attachedRuntimeKey === key) {
      this.detachAttachedRuntime();
    }
    this.runtimes.delete(key);
    const webContents = runtime.view.webContents;
    if (!webContents.isDestroyed()) {
      webContents.close({ waitForBeforeUnload: false });
    }
  }

  private getOrCreateState(sessionId: string): SessionBrowserState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const initial = defaultSessionBrowserState(sessionId);
    this.states.set(sessionId, initial);
    return initial;
  }

  private ensureWorkspace(sessionId: string, initialUrl?: string): SessionBrowserState {
    const state = this.getOrCreateState(sessionId);
    if (state.tabs.length === 0) {
      const initialTab = createBrowserTab(normalizeUrlInput(initialUrl));
      state.tabs = [initialTab];
      state.activeTabId = initialTab.id;
    }
    if (!state.activeTabId || !state.tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }
    return state;
  }

  private resolveTab(state: SessionBrowserState, tabId?: string): BrowserTabState {
    const resolvedTabId = tabId ?? state.activeTabId;
    const existing =
      (resolvedTabId ? state.tabs.find((tab) => tab.id === resolvedTabId) : undefined) ??
      state.tabs[0];
    if (existing) return existing;
    const fallback = createBrowserTab();
    state.tabs = [fallback];
    state.activeTabId = fallback.id;
    return fallback;
  }

  private getActiveTab(state: SessionBrowserState): BrowserTabState | null {
    if (!state.activeTabId) return state.tabs[0] ?? null;
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  }

  private getTab(state: SessionBrowserState, tabId: string): BrowserTabState | null {
    return state.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  private emitState(sessionId: string): void {
    const state = cloneSessionState(this.getOrCreateState(sessionId));
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private emitSendSelection(event: BrowserSendSelectionToChatEvent): void {
    for (const listener of this.selectionListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Browser send-selection listener failed:', error);
      }
    }
  }

  private handleContextMenu(
    sessionId: string,
    tabId: string,
    params: Electron.ContextMenuParams
  ): void {
    const runtime = this.runtimes.get(buildRuntimeKey(sessionId, tabId));
    if (!runtime || runtime.view.webContents.isDestroyed()) return;
    const webContents = runtime.view.webContents;
    const selectionText = params.selectionText?.trim() ?? '';
    const hasSelection = selectionText.length > 0;
    const linkUrl = params.linkURL;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (hasSelection) {
      template.push({
        label: 'Send selection to chat',
        click: () => {
          this.emitSendSelection({
            sessionId,
            tabId,
            selectionText,
            pageUrl: webContents.getURL(),
            pageTitle: webContents.getTitle(),
          });
        },
      });
      template.push({ type: 'separator' });
      template.push({
        label: 'Copy',
        role: 'copy',
      });
      template.push({
        label: 'Search the web',
        click: () => {
          this.newTab({
            sessionId,
            url: `${SEARCH_URL_PREFIX}${encodeURIComponent(selectionText)}`,
            activate: true,
          });
        },
      });
    }

    if (linkUrl) {
      if (hasSelection) template.push({ type: 'separator' });
      template.push({
        label: 'Open link in new tab',
        click: () => {
          this.newTab({ sessionId, url: linkUrl, activate: true });
        },
      });
      template.push({
        label: 'Copy link address',
        click: () => {
          clipboard.writeText(linkUrl);
        },
      });
    }

    if (template.length > 0) template.push({ type: 'separator' });
    template.push({
      label: 'Back',
      enabled: webContents.canGoBack(),
      click: () => webContents.goBack(),
    });
    template.push({
      label: 'Forward',
      enabled: webContents.canGoForward(),
      click: () => webContents.goForward(),
    });
    template.push({
      label: 'Reload',
      click: () => webContents.reload(),
    });
    template.push({ type: 'separator' });
    template.push({
      label: 'Inspect element',
      click: () => webContents.inspectElement(params.x, params.y),
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: this.window ?? undefined });
  }
}

function syncTabStateFromRuntime(
  state: SessionBrowserState,
  tab: BrowserTabState,
  webContents: WebContentsView['webContents'],
  faviconUrls?: string[]
): void {
  const currentUrl = webContents.getURL();
  const nextUrl = currentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  tab.status = 'live';
  tab.url = nextUrl;
  tab.title = !nextTitle || nextTitle === ABOUT_BLANK_URL ? defaultTitleForUrl(nextUrl) : nextTitle;
  tab.isLoading = webContents.isLoading();
  tab.canGoBack = webContents.canGoBack();
  tab.canGoForward = webContents.canGoForward();
  tab.lastCommittedUrl = currentUrl || tab.lastCommittedUrl;
  if (faviconUrls) {
    tab.faviconUrl = faviconUrls[0] ?? tab.faviconUrl;
  }
  if (tab.lastError && !tab.isLoading) {
    tab.lastError = null;
  }
  syncSessionLastError(state);
}

function syncSessionLastError(state: SessionBrowserState): void {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  state.lastError = activeTab?.lastError ?? null;
}

// Singleton instance used across ipc handlers.
export const browserManager = new BrowserManager();
