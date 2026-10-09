// In-app browser, one page per browser session (a chat's browser utility
// tab). The panel in the renderer reports where the page should appear; this
// manager keeps a native page view for it, shows at most one on the window,
// suspends pages nobody has looked at for a while (or the longest unseen ones
// once too many are live), and lends pages to browser_use (which may drive
// them with the panel closed).

import { Menu, clipboard, shell, type BrowserWindow, type ContextMenuParams, type WebContents } from 'electron';
import { BLANK_PAGE, resolveAddress, webSearchUrl } from '../shared/browser-address';
import type {
  BrowserCapturePageResult,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserPage,
  BrowserReadoutLink,
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserSessionInput,
  BrowserSessionState,
  BrowserViewport,
  BrowserViewportInput,
} from '../shared/browser-types';
import { BROWSER_SESSION_PARTITION } from '../shared/browser-types';
import {
  absorb,
  blankSession,
  copySession,
  describeLoadFailure,
  GENERIC_LOAD_FAILURE,
  loadFailed,
  navigationStarted,
  newPage,
  retarget,
  suspend,
} from './browser/browser-page';
import { pageBackground, PageView } from './browser/page-view';
import { installBrowserSessionPolicy } from './browser/session-policy';
import { ViewPlacement } from './browser/view-placement';
import { isLocalFileUrl } from './libs/html-preview';
import { normalizeExternalUrl } from './util';

export { BROWSER_SESSION_PARTITION };

/** A page nobody has looked at for this long gives up its renderer process. */
const IDLE_SUSPEND_MS = 10 * 60_000;
/**
 * Off-screen pages kept live at once, so switching away from a dev server page
 * and back keeps its state. The page on screen, design mode's and the ones an
 * agent is driving don't count; past this the longest unseen are suspended.
 */
const LIVE_PAGE_BUDGET = 6;
const NOT_LIVE = 'This page is not active right now.';
const READOUT_TEXT_LIMIT = 20_000;
const READOUT_SELECTION_LIMIT = 8_000;
const READOUT_LINK_LIMIT = 80;

export interface BrowserAgentTarget {
  /** The session page's id. */
  tabId: string;
  webContents: WebContents;
  /** Resolves once a page that was suspended has loaded its address again. */
  restore: Promise<void>;
  /** True only while the page is on screen in the panel. */
  visible: boolean;
}

/** One of a chat's browser tabs, as browser_use names it. */
export interface BrowserAgentTab {
  /** 'main' for the chat's base tab, else the tab's 'browser:…' id. */
  tab: string;
  browserSessionId: string;
  url: string;
  title: string;
}

type Listener<T> = (value: T) => void;

/** The chat's base tab uses the chat id; extra tabs append their 'browser:…' id. */
function isChatBrowserSession(sessionId: string, chatSessionId: string): boolean {
  return sessionId === chatSessionId || sessionId.startsWith(`${chatSessionId}:browser:`);
}

/** Main-process addresses: file: must point at this machine. */
function resolveForLoad(input: string | undefined): string {
  const url = resolveAddress(input);
  if (url.startsWith('file:') && !isLocalFileUrl(url)) throw new Error('Browser preview requires a local file URL');
  return url;
}

function validViewport(viewport: BrowserViewport | null): BrowserViewport | null {
  if (!viewport || ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return null;
  const rect = {
    x: Math.max(0, Math.floor(viewport.x)),
    y: Math.max(0, Math.floor(viewport.y)),
    width: Math.max(0, Math.floor(viewport.width)),
    height: Math.max(0, Math.floor(viewport.height)),
  };
  return rect.width && rect.height ? rect : null;
}

// Runs in the page: visible text without scripts and styles, the selection,
// and distinct http(s) links.
const READOUT_SCRIPT = `(() => {
  const copy = document.cloneNode(true);
  copy.querySelectorAll('script, style, noscript, template, iframe').forEach((node) => node.remove());
  const root = copy.body || copy.documentElement;
  const text = ((root && root.innerText) || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const links = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.size >= ${READOUT_LINK_LIMIT}) break;
    const href = anchor.href;
    if (!/^https?:/i.test(href) || links.has(href)) continue;
    links.set(href, (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200));
  }
  return {
    url: location.href,
    title: document.title || '',
    text: text.slice(0, ${READOUT_TEXT_LIMIT}),
    selection: String((window.getSelection && window.getSelection()) || '').slice(0, ${READOUT_SELECTION_LIMIT}),
    links: [...links].map(([url, label]) => ({ url, text: label })),
  };
})()`;

export class BrowserManager {
  private window: BrowserWindow | null = null;
  private readonly placement = new ViewPlacement();
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly views = new Map<string, PageView>();
  /** The session whose page the panel shows, and where. */
  private foreground: string | null = null;
  private viewport: BrowserViewport | null = null;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each live page last went off screen, as an ever-growing sequence. */
  private readonly offscreenOrder = new Map<string, number>();
  private offscreenSequence = 0;
  /** Design mode keeps its session's page alive. */
  private readonly pinned = new Set<string>();
  /** browser_use keeps its session's page alive until the turn ends. */
  private readonly agentHolds = new Set<string>();
  private readonly agentDepth = new Map<string, number>();
  private readonly stateListeners = new Set<Listener<BrowserSessionState>>();
  private readonly selectionListeners = new Set<Listener<BrowserSendSelectionEvent>>();
  private readonly hostReloadListeners = new Set<() => void>();
  private unhookHost: (() => void) | null = null;

  setWindow(window: BrowserWindow | null): void {
    this.unhookHost?.();
    this.unhookHost = null;
    this.window = window;
    this.placement.setWindow(window);
    if (!window) {
      for (const sessionId of [...this.views.keys()]) this.dropView(sessionId);
      this.placement.closeAgentHost();
      return;
    }
    // A full reload of the app's renderer skips React cleanup, so nothing
    // would hide the native view or let its session suspend. Reset here; the
    // panel reopens what it needs after boot.
    const contents = window.webContents;
    const onNavigate = () => this.handleHostRendererReload();
    contents.on('did-navigate', onNavigate);
    this.unhookHost = () => {
      if (!contents.isDestroyed()) contents.removeListener('did-navigate', onNavigate);
    };
    if (this.foreground && this.viewport) this.bringForward(this.foreground, this.viewport);
  }

  /** Called before page state resets on an app renderer reload (design mode cleans up here). */
  onHostRendererReload(listener: () => void): () => void {
    this.hostReloadListeners.add(listener);
    return () => this.hostReloadListeners.delete(listener);
  }

  private handleHostRendererReload(): void {
    for (const listener of this.hostReloadListeners) {
      try {
        listener();
      } catch (error) {
        console.error('[browser] host reload listener failed:', error);
      }
    }
    this.pinned.clear();
    this.placement.hide();
    this.foreground = null;
    this.viewport = null;
    for (const sessionId of this.sessions.keys()) this.suspendSession(sessionId);
  }

  subscribe(listener: Listener<BrowserSessionState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeSendSelection(listener: Listener<BrowserSendSelectionEvent>): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.placement.hide();
    for (const sessionId of [...this.views.keys()]) this.dropView(sessionId);
    this.placement.closeAgentHost();
    this.stateListeners.clear();
    this.selectionListeners.clear();
    this.sessions.clear();
    this.agentHolds.clear();
    this.agentDepth.clear();
    this.pinned.clear();
    this.window = null;
    this.placement.setWindow(null);
    this.foreground = null;
    this.viewport = null;
  }

  // ===== Panel API =====

  open(input: BrowserOpenInput): BrowserSessionState {
    const session = this.session(input.sessionId);
    this.ensurePage(session, input.initialUrl);
    session.open = true;
    if (this.viewport && (!this.foreground || this.foreground === input.sessionId)) {
      this.bringForward(input.sessionId, this.viewport);
    }
    return this.publish(input.sessionId);
  }

  close(input: BrowserSessionInput): BrowserSessionState {
    this.cancelIdle(input.sessionId);
    if (this.foreground === input.sessionId) {
      this.placement.hide();
      this.foreground = null;
    }
    this.dropView(input.sessionId);
    const session = this.session(input.sessionId);
    session.open = false;
    session.page = null;
    return this.publish(input.sessionId);
  }

  /** A deleted chat takes its browser pages (the base tab and any extra ones) with it. */
  closeChat(chatSessionId: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      if (!isChatBrowserSession(sessionId, chatSessionId)) continue;
      this.pinned.delete(sessionId);
      this.close({ sessionId });
      this.sessions.delete(sessionId);
    }
  }

  hide(input: BrowserSessionInput): void {
    if (!this.sessions.get(input.sessionId)?.open) return;
    if (this.foreground === input.sessionId) {
      this.placement.hide();
      this.foreground = null;
    }
    this.scheduleIdle(input.sessionId);
  }

  getState(input: BrowserSessionInput): BrowserSessionState {
    return copySession(this.session(input.sessionId));
  }

  /** Follow the app theme in every live page view. */
  applyThemeBackground(): void {
    const color = pageBackground();
    for (const view of this.views.values()) view.setBackground(color);
  }

  setPanelBounds(input: BrowserViewportInput): BrowserSessionState {
    const session = this.session(input.sessionId);
    const viewport = validViewport(input.viewport);
    if (!session.open || !viewport) {
      if (this.foreground === input.sessionId) {
        this.placement.hide();
        this.foreground = null;
        this.viewport = viewport;
        this.scheduleIdle(input.sessionId);
      }
      return copySession(session);
    }
    this.bringForward(input.sessionId, viewport);
    return copySession(session);
  }

  navigate(input: BrowserNavigateInput): BrowserSessionState {
    const url = resolveForLoad(input.url);
    const session = this.session(input.sessionId);
    const page = this.ensurePage(session);
    retarget(page, url);
    // A page that still has a view loads right away, on screen or not, so
    // the address it shows is never overwritten by what it had before.
    let view = this.views.get(input.sessionId);
    if (!view && this.foreground === input.sessionId) view = this.createView(input.sessionId);
    if (view) {
      this.cancelIdle(input.sessionId);
      if (this.foreground === input.sessionId && this.viewport) this.placement.show(view, this.viewport);
      void this.loadInto(input.sessionId, view, url);
    } else {
      suspend(page);
    }
    return this.publish(input.sessionId);
  }

  reload(input: BrowserSessionInput): BrowserSessionState {
    const view = this.views.get(input.sessionId);
    if (view?.alive) view.contents.reload();
    else if (this.foreground === input.sessionId) this.wake(input.sessionId);
    return this.getState(input);
  }

  goBack(input: BrowserSessionInput): BrowserSessionState {
    const history = this.views.get(input.sessionId)?.contents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
    return this.getState(input);
  }

  goForward(input: BrowserSessionInput): BrowserSessionState {
    const history = this.views.get(input.sessionId)?.contents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
    return this.getState(input);
  }

  openDevTools(input: BrowserSessionInput): void {
    const session = this.session(input.sessionId);
    this.ensurePage(session);
    const view = this.views.get(input.sessionId) ?? this.wakeView(input.sessionId);
    if (this.foreground === input.sessionId && this.viewport) this.placement.show(view, this.viewport);
    view.contents.openDevTools({ mode: 'detach' });
  }

  // ===== Screenshot and readout =====

  async capturePage(input: BrowserSessionInput): Promise<BrowserCapturePageResult> {
    const live = this.livePage(input.sessionId);
    if (!live) return { ok: false, message: NOT_LIVE };
    try {
      const image = await live.view.contents.capturePage();
      if (image.isEmpty()) return { ok: false, message: 'Captured image is empty.' };
      const base64 = image.toPNG().toString('base64');
      const { width, height } = image.getSize();
      return {
        ok: true,
        dataUrl: `data:image/png;base64,${base64}`,
        mimeType: 'image/png',
        width,
        height,
        base64,
        pageUrl: live.view.contents.getURL() || live.page.url,
        pageTitle: live.view.contents.getTitle() || live.page.title,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async readPageContent(input: BrowserSessionInput): Promise<BrowserReadoutResult> {
    const live = this.livePage(input.sessionId);
    if (!live) return { ok: false, message: NOT_LIVE };
    try {
      const result = (await live.view.contents.executeJavaScript(READOUT_SCRIPT, true)) as {
        url: string;
        title: string;
        text: string;
        selection: string;
        links: BrowserReadoutLink[];
      };
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The page's live contents, or null once suspended or replaced (design mode re-checks each poll). */
  getLiveWebContents(sessionId: string, pageId: string): WebContents | null {
    const live = this.livePage(sessionId);
    return live && live.page.id === pageId ? live.view.contents : null;
  }

  // ===== browser_use =====

  /**
   * Lends the session's page to an agent. With the panel closed the page
   * lives in a hidden window; opening the panel later shows that same page,
   * so the agent and the user never see different browsing state.
   */
  acquireAgentTarget(sessionId: string): BrowserAgentTarget {
    const page = this.ensurePage(this.session(sessionId));
    this.agentHolds.add(sessionId);
    this.cancelIdle(sessionId);
    const existing = this.views.get(sessionId);
    const view = existing ?? this.createView(sessionId);
    const visible = this.foreground === sessionId && this.placement.visible === view && !!this.viewport;
    if (!visible) this.placement.park(view);
    const needsLoad = !existing && page.url !== BLANK_PAGE && view.contents.getURL() !== page.url;
    const restore = needsLoad ? this.loadInto(sessionId, view, page.url) : Promise.resolve();
    this.publish(sessionId);
    return { tabId: page.id, webContents: view.contents, restore, visible };
  }

  /**
   * Ends browser_use's hold after a turn. An off-screen page leaves the hidden
   * window but stays live like any other unseen page, so opening the panel
   * afterwards shows what the agent left, not a reload of it.
   */
  releaseAgentSession(sessionId: string): void {
    this.agentHolds.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const onScreen = this.foreground === sessionId && this.placement.visible !== null;
    if (session && !onScreen) {
      const view = this.views.get(sessionId);
      if (view) this.placement.remove(view);
      session.agentActive = false;
      this.agentDepth.delete(sessionId);
      this.publish(sessionId);
      this.scheduleIdle(sessionId);
    }
    if (!this.agentHolds.size) this.placement.closeAgentHost();
  }

  /** Ends every hold an agent took on the chat's tabs during a turn. */
  releaseAgentChat(chatSessionId: string): void {
    for (const sessionId of [...this.agentHolds]) {
      if (isChatBrowserSession(sessionId, chatSessionId)) this.releaseAgentSession(sessionId);
    }
  }

  /** The chat's tabs an agent may act on: the main one, then extra tabs that have a page. */
  agentTabs(chatSessionId: string): BrowserAgentTab[] {
    const main = this.sessions.get(chatSessionId)?.page;
    const tabs: BrowserAgentTab[] = [
      { tab: 'main', browserSessionId: chatSessionId, url: main?.url ?? '', title: main?.title ?? '' },
    ];
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === chatSessionId || !isChatBrowserSession(sessionId, chatSessionId) || !session.page) continue;
      tabs.push({
        tab: sessionId.slice(chatSessionId.length + 1),
        browserSessionId: sessionId,
        url: session.page.url,
        title: session.page.title,
      });
    }
    return tabs;
  }

  /** Lights the panel's agent badge while `action` runs; nested actions keep it lit. */
  async withAgentActivity<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (!session) return action();
    const depth = (this.agentDepth.get(sessionId) ?? 0) + 1;
    this.agentDepth.set(sessionId, depth);
    if (depth === 1) {
      session.agentActive = true;
      this.publish(sessionId);
    }
    try {
      return await action();
    } finally {
      const remaining = (this.agentDepth.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.agentDepth.set(sessionId, remaining);
      else {
        this.agentDepth.delete(sessionId);
        session.agentActive = false;
        this.publish(sessionId);
      }
    }
  }

  /** Design mode pins its session so idle suspension keeps its page and inspector. */
  setSessionPinned(sessionId: string, pinned: boolean): void {
    if (pinned) {
      this.pinned.add(sessionId);
      this.cancelIdle(sessionId);
    } else {
      this.pinned.delete(sessionId);
      if (this.foreground !== sessionId) this.scheduleIdle(sessionId);
    }
  }

  // ===== Internals =====

  private session(sessionId: string): BrowserSessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = blankSession(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private ensurePage(session: BrowserSessionState, initialUrl?: string): BrowserPage {
    if (!session.page) {
      let url = BLANK_PAGE;
      try {
        url = resolveForLoad(initialUrl);
      } catch {
        // A remembered address that no longer loads here (a file: URL that
        // isn't local) starts blank rather than failing the panel.
      }
      session.page = newPage(url);
    }
    return session.page;
  }

  private publish(sessionId: string): BrowserSessionState {
    const snapshot = copySession(this.session(sessionId));
    for (const listener of this.stateListeners) listener(copySession(snapshot));
    return snapshot;
  }

  private livePage(sessionId: string): { page: BrowserPage; view: PageView } | null {
    const page = this.sessions.get(sessionId)?.page;
    const view = this.views.get(sessionId);
    return page && view?.alive ? { page, view } : null;
  }

  private bringForward(sessionId: string, viewport: BrowserViewport): void {
    const previous = this.foreground;
    this.foreground = sessionId;
    this.viewport = viewport;
    const view = this.wake(sessionId);
    if (view) this.placement.show(view, viewport);
    // After the switch: scheduleIdle skips whatever is in the foreground.
    if (previous && previous !== sessionId) this.scheduleIdle(previous);
  }

  /** Makes sure an open session's page has a view, loading it again when it had none. */
  private wake(sessionId: string): PageView | null {
    const session = this.sessions.get(sessionId);
    if (!session?.open || !session.page) return null;
    this.cancelIdle(sessionId);
    const existing = this.views.get(sessionId);
    if (existing?.alive) {
      absorb(session.page, existing.facts());
      this.publish(sessionId);
      return existing;
    }
    return this.wakeView(sessionId);
  }

  private wakeView(sessionId: string): PageView {
    const view = this.createView(sessionId);
    const page = this.sessions.get(sessionId)?.page;
    if (page) void this.loadInto(sessionId, view, page.url);
    return view;
  }

  private createView(sessionId: string): PageView {
    this.dropView(sessionId);
    // Before the first page loads: the partition answers permission requests.
    installBrowserSessionPolicy(() => this.window);
    const page = () => this.sessions.get(sessionId)?.page ?? null;
    const view: PageView = new PageView({
      facts: (facts) => {
        const current = page();
        if (!current) return;
        absorb(current, facts);
        this.publish(sessionId);
      },
      started: () => {
        const current = page();
        if (!current) return;
        navigationStarted(current);
        this.publish(sessionId);
      },
      failed: (code, url) => {
        const current = page();
        if (!current) return;
        loadFailed(current, describeLoadFailure(code), url || undefined);
        this.publish(sessionId);
      },
      openWindow: (url) => this.openFromPage(sessionId, url),
      contextMenu: (params) => this.showContextMenu(sessionId, view, params),
      crashed: () => {
        this.dropView(sessionId);
        const current = page();
        if (current) {
          suspend(current);
          current.error = 'This page stopped unexpectedly.';
          this.publish(sessionId);
        }
        if (this.foreground === sessionId && this.viewport) this.bringForward(sessionId, this.viewport);
      },
    });
    this.views.set(sessionId, view);
    const current = page();
    if (current) current.phase = 'live';
    return view;
  }

  private dropView(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    this.views.delete(sessionId);
    this.offscreenOrder.delete(sessionId);
    this.placement.remove(view);
    view.retire();
  }

  private async loadInto(sessionId: string, view: PageView, url: string): Promise<void> {
    const page = this.sessions.get(sessionId)?.page;
    if (!page) return;
    navigationStarted(page);
    this.publish(sessionId);
    const outcome = await view.load(url);
    if (outcome === 'retired' || this.views.get(sessionId) !== view) return;
    if (outcome === 'failed') {
      // did-fail-load usually explains the failure already; keep that message.
      loadFailed(page, page.error ?? GENERIC_LOAD_FAILURE);
    } else {
      absorb(page, view.facts());
    }
    this.publish(sessionId);
  }

  /** A live page just went off screen: start its idle timer and keep the live set within budget. */
  private scheduleIdle(sessionId: string): void {
    if (!this.views.has(sessionId) || this.foreground === sessionId) return;
    if (this.pinned.has(sessionId) || this.agentHolds.has(sessionId)) return;
    this.cancelIdle(sessionId);
    this.offscreenOrder.set(sessionId, ++this.offscreenSequence);
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      this.suspendSession(sessionId);
    }, IDLE_SUSPEND_MS);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
    this.trimLivePages();
  }

  /** Suspends the longest unseen off-screen pages beyond LIVE_PAGE_BUDGET. */
  private trimLivePages(): void {
    const unseen = [...this.views.keys()].filter(
      (sessionId) => sessionId !== this.foreground && !this.pinned.has(sessionId) && !this.agentHolds.has(sessionId)
    );
    if (unseen.length <= LIVE_PAGE_BUDGET) return;
    unseen.sort((a, b) => (this.offscreenOrder.get(a) ?? 0) - (this.offscreenOrder.get(b) ?? 0));
    for (const sessionId of unseen.slice(0, unseen.length - LIVE_PAGE_BUDGET)) {
      this.cancelIdle(sessionId);
      this.suspendSession(sessionId);
    }
  }

  private cancelIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private suspendSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || this.foreground === sessionId || this.pinned.has(sessionId) || this.agentHolds.has(sessionId)) return;
    this.dropView(sessionId);
    if (session.page) suspend(session.page);
    this.publish(sessionId);
  }

  /** Pages may not open windows: web and local addresses load in place, others go to the system. */
  private openFromPage(sessionId: string, url: string): void {
    if (/^https?:\/\//i.test(url) || url === BLANK_PAGE || isLocalFileUrl(url)) {
      this.navigate({ sessionId, url });
      return;
    }
    const external = normalizeExternalUrl(url);
    if (external) void shell.openExternal(external);
  }

  private showContextMenu(sessionId: string, view: PageView, params: ContextMenuParams): void {
    if (!view.alive) return;
    const contents = view.contents;
    const history = contents.navigationHistory;
    const selection = params.selectionText?.trim() ?? '';
    const groups: Electron.MenuItemConstructorOptions[][] = [];
    if (selection) {
      groups.push([
        {
          label: 'Send selection to chat',
          click: () => {
            const pageId = this.sessions.get(sessionId)?.page?.id;
            if (!pageId) return;
            const event = { sessionId, pageId, selectionText: selection, pageUrl: contents.getURL(), pageTitle: contents.getTitle() };
            for (const listener of this.selectionListeners) {
              try {
                listener(event);
              } catch (error) {
                console.error('[browser] selection listener failed:', error);
              }
            }
          },
        },
      ]);
      groups.push([
        { label: 'Copy', role: 'copy' },
        { label: 'Search the web', click: () => this.navigate({ sessionId, url: webSearchUrl(selection) }) },
      ]);
    }
    if (params.linkURL) {
      const link = params.linkURL;
      groups.push([
        { label: 'Open link', click: () => this.navigate({ sessionId, url: link }) },
        { label: 'Copy link address', click: () => clipboard.writeText(link) },
      ]);
    }
    groups.push([
      { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', click: () => contents.reload() },
    ]);
    groups.push([{ label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) }]);
    const template = groups.flatMap((group, index) => (index ? [{ type: 'separator' as const }, ...group] : group));
    Menu.buildFromTemplate(template).popup({ window: this.window ?? undefined });
  }
}

export const browserManager = new BrowserManager();
