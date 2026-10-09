// Design-mode orchestration: inspector injection & polling, selection and
// annotate events, element geometry for screenshot cropping.
//
// DELIBERATELY WRITE-FREE. Design mode used to carry a deterministic
// Tailwind write-back engine (tailwind-map / write-plan / verify-loop, see
// git history around feat/design-mode); it was removed as a product
// decision: the AGENT is the only writer of user source files, so design
// mode can never race it. Design mode's job is pointing and intent capture
// — the annotate bubble packages "what to change, where" for the composer.
import type { WebContents } from 'electron';
import { browserManager } from './browserManager';
import { INSPECTOR_SCRIPT } from './libs/design-writeback/inspector-script';
// The renderer↔main contract lives in ONE place — shared/design-mode-types —
// same convention as browser-ipc/browser-types. Do not re-declare it here.
import type {
  DesignCapabilities,
  DesignModeEvent,
  DesignModeTarget,
  DesignSelectionInfo,
} from '../shared/design-mode-types';

export type { DesignModeTarget } from '../shared/design-mode-types';

const POLL_INTERVAL_MS = 300;
/** Isolated world for the inspector on sites other than the user's own dev pages. */
const DESIGN_WORLD_ID = 1920;

/**
 * Where the inspector runs. Dev pages (localhost, local files) get the page's
 * own world, where React's fiber and source data are readable. Other sites
 * get an isolated world: the page can neither read nor forge annotations.
 */
type InspectorWorld = 'page' | 'isolated';

interface DesignSessionState {
  sessionId: string;
  tabId: string;
  projectRoot: string;
  pollTimer: NodeJS.Timeout | null;
  capabilities: DesignCapabilities;
  /** Ownership token — stale disables must not tear down a successor. */
  token: number;
  world: InspectorWorld;
}

let nextSessionToken = 1;

function keyOf(target: DesignModeTarget): string {
  return `${target.sessionId}:${target.tabId}`;
}

function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Web pages and local files; not about:, data: or internal pages. */
function isInspectableUrl(rawUrl: string): boolean {
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function worldFor(rawUrl: string): InspectorWorld {
  return isLocalhostUrl(rawUrl) || rawUrl.startsWith('file:') ? 'page' : 'isolated';
}

function runIn(wc: WebContents, world: InspectorWorld, code: string): Promise<unknown> {
  return world === 'page'
    ? wc.executeJavaScript(code, true)
    : wc.executeJavaScriptInIsolatedWorld(DESIGN_WORLD_ID, [{ code }], true);
}

const DRAIN = 'window.__aegisDesignDrain ? window.__aegisDesignDrain() : null';

export class DesignModeService {
  private readonly sessions = new Map<string, DesignSessionState>();
  private listener: ((event: DesignModeEvent) => void) | null = null;

  constructor() {
    // A host renderer reload resets the UI to designTarget=null, but our poll
    // timers would keep running and re-inject the inspector into freshly
    // created runtimes — page clicks hijacked while the toolbar shows design
    // mode as off. Dispose every design session alongside the native views.
    browserManager.onHostRendererReload(() => this.disposeAll('host-reload'));
  }

  private disposeAll(reason: string): void {
    for (const state of this.sessions.values()) {
      if (state.pollTimer) clearInterval(state.pollTimer);
      this.emit({ kind: 'disabled', sessionId: state.sessionId, tabId: state.tabId, reason });
    }
    this.sessions.clear();
  }

  subscribe(listener: (event: DesignModeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  private emit(event: DesignModeEvent): void {
    this.listener?.(event);
  }

  private webContentsFor(target: DesignModeTarget): WebContents | null {
    return browserManager.getLiveWebContents(target.sessionId, target.tabId);
  }

  /**
   * Ownership guard for async continuations: disable/enable interleave with
   * in-flight polls and drains, and a stale continuation must never touch
   * the page (re-inject, clear helpers) on behalf of a session that has been
   * replaced or removed.
   */
  private isCurrent(state: DesignSessionState): boolean {
    return this.sessions.get(keyOf(state)) === state;
  }

  async enable(
    input: DesignModeTarget & { projectRoot: string }
  ): Promise<{ ok: boolean; message?: string; capabilities?: DesignCapabilities; token?: number }> {
    const wc = this.webContentsFor(input);
    if (!wc) return { ok: false, message: 'This browser tab is not active.' };

    const url = wc.getURL() || '';
    if (!isInspectableUrl(url)) {
      return { ok: false, message: 'Open a web page first, then annotate it.' };
    }
    const world = worldFor(url);

    try {
      await runIn(wc, world, INSPECTOR_SCRIPT);
    } catch (error) {
      return { ok: false, message: `Failed to inject inspector: ${error instanceof Error ? error.message : String(error)}` };
    }

    const capabilities = await this.probeCapabilities(wc, url, world);
    const key = keyOf(input);
    const existing = this.sessions.get(key);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);

    const state: DesignSessionState = {
      sessionId: input.sessionId,
      tabId: input.tabId,
      projectRoot: input.projectRoot,
      pollTimer: null,
      capabilities,
      token: nextSessionToken++,
      world,
    };
    state.pollTimer = setInterval(() => {
      void this.pollOnce(state);
    }, POLL_INTERVAL_MS);
    state.pollTimer.unref();
    this.sessions.set(key, state);

    browserManager.setSessionPinned(input.sessionId, true);
    this.emit({ kind: 'enabled', sessionId: input.sessionId, tabId: input.tabId, capabilities });
    return { ok: true, capabilities, token: state.token };
  }

  private async probeCapabilities(wc: WebContents, url: string, world: InspectorWorld): Promise<DesignCapabilities> {
    let reactFiber = false;
    let hmrClient = false;
    // React's fiber data lives in the page's own world.
    if (world === 'isolated') return { reactFiber, hmrClient, localhost: false };
    try {
      const probe = (await wc.executeJavaScript(
        `(() => {
          let fiber = false;
          const all = document.querySelectorAll('*');
          for (let i = 0; i < all.length && i < 400; i += 1) {
            for (const key in all[i]) { if (key.indexOf('__reactFiber$') === 0) { fiber = true; break; } }
            if (fiber) break;
          }
          const hmr = Boolean(document.querySelector('script[src*="/@vite/client"]')) ||
            Boolean(window.__vite_plugin_react_preamble_installed__) ||
            Boolean(window.webpackHotUpdate) || Boolean(window.__webpack_hash__);
          return JSON.stringify({ fiber, hmr });
        })()`,
        true
      )) as string;
      const parsed = JSON.parse(probe) as { fiber: boolean; hmr: boolean };
      reactFiber = parsed.fiber;
      hmrClient = parsed.hmr;
    } catch {
      // Probe failure leaves capabilities pessimistic.
    }
    return { reactFiber, hmrClient, localhost: isLocalhostUrl(url) };
  }

  async disable(input: DesignModeTarget & { token?: number }, reason = 'user'): Promise<void> {
    const key = keyOf(input);
    const state = this.sessions.get(key);
    // Token-scoped disables only tear down the session they own: a stale
    // disable (outdated enable resolution / late IPC) arriving after a newer
    // enable installed a successor under the same key must be a no-op.
    if (typeof input.token === 'number' && (!state || state.token !== input.token)) return;
    if (state?.pollTimer) clearInterval(state.pollTimer);
    this.sessions.delete(key);
    const stillPinned = [...this.sessions.values()].some((s) => s.sessionId === input.sessionId);
    if (!stillPinned) browserManager.setSessionPinned(input.sessionId, false);
    const wc = this.webContentsFor(input);
    if (wc && state) {
      // Final drain: an annotation submitted moments before disable (Enter →
      // immediately collapse/switch) would otherwise be lost in the in-page
      // queue — or replayed weirdly the next time design mode is enabled.
      try {
        const raw = await runIn(wc, state.world, DRAIN);
        if (raw !== null) this.forwardDrainedEvents(state, String(raw));
      } catch {
        // Best-effort; the page may already be gone.
      }
    }
    // Toggle-off-then-on race: if a NEW session was installed under the same
    // key while we awaited the drain, the page now belongs to it — do not
    // strip its helpers or emit a 'disabled' that would clear the fresh UI
    // target.
    if (this.sessions.has(key)) return;
    if (wc && state) {
      await runIn(
        wc,
        state.world,
        `(() => { if (window.__aegisDesignClearSelection) window.__aegisDesignClearSelection(); if (window.__aegisDesignSetEnabled) window.__aegisDesignSetEnabled(false); return true; })()`
      ).catch(() => undefined);
    }
    this.emit({ kind: 'disabled', sessionId: input.sessionId, tabId: input.tabId, reason });
  }

  private async pollOnce(state: DesignSessionState): Promise<void> {
    if (!this.isCurrent(state)) return;
    const wc = this.webContentsFor(state);
    if (!wc) {
      await this.disable(state, 'page-gone');
      return;
    }
    let raw: unknown = null;
    try {
      raw = await runIn(wc, state.world, DRAIN);
    } catch {
      raw = null;
    }
    // A disable() that ran while we awaited must win: acting here would
    // re-enable the inspector on a page the session no longer owns. But the
    // drain already REMOVED events from the page queue — a just-submitted
    // annotation must still be forwarded, or it is lost to both paths.
    if (!this.isCurrent(state)) {
      if (raw !== null) this.forwardDrainedEvents(state, String(raw));
      return;
    }
    if (raw === null) {
      // The tab may have been closed/suspended while the drain was in
      // flight; getURL/executeJavaScript on a destroyed WebContents throw
      // synchronously, outside any try below.
      if (wc.isDestroyed()) {
        await this.disable(state, 'page-gone');
        return;
      }
      // Injection lost (navigation / reload). Re-inject on any web page, in
      // the world that page calls for.
      const url = wc.getURL() || '';
      if (!isInspectableUrl(url)) {
        await this.disable(state, 'left-page');
        return;
      }
      const world = worldFor(url);
      try {
        await runIn(wc, world, INSPECTOR_SCRIPT);
        if (!this.isCurrent(state)) {
          // Disabled mid-injection: the fresh inspector must not stay active.
          await runIn(wc, world, 'window.__aegisDesignSetEnabled && window.__aegisDesignSetEnabled(false)').catch(() => undefined);
          return;
        }
        state.world = world;
        this.emit({ kind: 'reinjected', sessionId: state.sessionId, tabId: state.tabId });
      } catch {
        // Try again next tick.
      }
      return;
    }
    this.forwardDrainedEvents(state, String(raw));
  }

  private forwardDrainedEvents(state: DesignSessionState, raw: string): void {
    try {
      const events = JSON.parse(raw) as Array<{
        kind: string;
        info?: DesignSelectionInfo;
        note?: string;
        viewport?: { w: number; h: number };
      }>;
      for (const event of events) {
        if (event.kind === 'selected' && event.info) {
          this.emit({ kind: 'selection', sessionId: state.sessionId, tabId: state.tabId, info: event.info });
        }
        if (event.kind === 'annotate' && event.info && typeof event.note === 'string' && event.note.trim()) {
          this.emit({
            kind: 'annotate',
            sessionId: state.sessionId,
            tabId: state.tabId,
            note: event.note,
            info: event.info,
            viewport: event.viewport,
          });
        }
      }
    } catch {
      // Malformed drain payload — ignore.
    }
  }

  /**
   * Drain (and forward) pending in-page events WITHOUT disabling — used by
   * navigation-family actions (navigate/reload/back/forward) that replace the
   * page context while design mode stays on. A note submitted right before
   * navigating would otherwise die with the old document.
   */
  async drainForBrowserSession(sessionId: string, tabId?: string): Promise<void> {
    for (const state of [...this.sessions.values()]) {
      if (state.sessionId !== sessionId) continue;
      if (tabId && state.tabId !== tabId) continue;
      const wc = this.webContentsFor(state);
      if (!wc || wc.isDestroyed()) continue;
      try {
        const raw = await runIn(wc, state.world, DRAIN);
        if (raw !== null) this.forwardDrainedEvents(state, String(raw));
      } catch {
        // Best-effort.
      }
    }
  }

  /**
   * Drain + tear down design sessions for a browser session/tab BEFORE its
   * WebContentsView is destroyed — close paths would otherwise kill the page
   * while a just-submitted annotation still sits in the in-page queue.
   */
  async disableForBrowserSession(sessionId: string, tabId?: string): Promise<void> {
    for (const state of [...this.sessions.values()]) {
      if (state.sessionId !== sessionId) continue;
      if (tabId && state.tabId !== tabId) continue;
      await this.disable(state, 'browser-closed');
    }
  }

  private async measurePage(wc: WebContents, world: InspectorWorld) {
    const raw = (await runIn(wc, world, 'window.__aegisDesignMeasure ? window.__aegisDesignMeasure() : null')) as string | null;
    if (!raw) return null;
    return JSON.parse(raw) as {
      found: boolean;
      rect?: { x: number; y: number; w: number; h: number };
      viewport?: { w: number; h: number };
    };
  }

  /**
   * Fresh geometry of the selected element (annotate crops the screenshot at
   * SUBMIT time — the selection-time rect goes stale the moment the page
   * scrolls or reflows).
   */
  async measureSelection(
    input: DesignModeTarget
  ): Promise<{ found: boolean; rect?: { x: number; y: number; w: number; h: number }; viewport?: { w: number; h: number } }> {
    const wc = this.webContentsFor(input);
    if (!wc) return { found: false };
    const state = this.sessions.get(keyOf(input));
    try {
      const measured = await this.measurePage(wc, state?.world ?? worldFor(wc.getURL() || ''));
      if (!measured) return { found: false };
      return { found: measured.found, rect: measured.rect, viewport: measured.viewport };
    } catch {
      return { found: false };
    }
  }
}

export const designModeService = new DesignModeService();
