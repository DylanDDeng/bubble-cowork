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

interface DesignSessionState {
  sessionId: string;
  tabId: string;
  projectRoot: string;
  pollTimer: NodeJS.Timeout | null;
  capabilities: DesignCapabilities;
}

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

export class DesignModeService {
  private readonly sessions = new Map<string, DesignSessionState>();
  private listener: ((event: DesignModeEvent) => void) | null = null;

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

  async enable(
    input: DesignModeTarget & { projectRoot: string }
  ): Promise<{ ok: boolean; message?: string; capabilities?: DesignCapabilities }> {
    const wc = this.webContentsFor(input);
    if (!wc) return { ok: false, message: 'This browser tab is not active.' };

    const url = wc.getURL() || '';
    if (!isLocalhostUrl(url)) {
      return {
        ok: false,
        message: 'Design mode only works on localhost dev pages. Start the project dev server and open it here first.',
      };
    }

    try {
      await wc.executeJavaScript(INSPECTOR_SCRIPT, true);
    } catch (error) {
      return { ok: false, message: `Failed to inject inspector: ${error instanceof Error ? error.message : String(error)}` };
    }

    const capabilities = await this.probeCapabilities(wc, url);
    const key = keyOf(input);
    const existing = this.sessions.get(key);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);

    const state: DesignSessionState = {
      sessionId: input.sessionId,
      tabId: input.tabId,
      projectRoot: input.projectRoot,
      pollTimer: null,
      capabilities,
    };
    state.pollTimer = setInterval(() => {
      void this.pollOnce(state);
    }, POLL_INTERVAL_MS);
    state.pollTimer.unref();
    this.sessions.set(key, state);

    browserManager.setSessionPinned(input.sessionId, true);
    this.emit({ kind: 'enabled', sessionId: input.sessionId, tabId: input.tabId, capabilities });
    return { ok: true, capabilities };
  }

  private async probeCapabilities(wc: WebContents, url: string): Promise<DesignCapabilities> {
    let reactFiber = false;
    let hmrClient = false;
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

  async disable(input: DesignModeTarget, reason = 'user'): Promise<void> {
    const key = keyOf(input);
    const state = this.sessions.get(key);
    if (state?.pollTimer) clearInterval(state.pollTimer);
    this.sessions.delete(key);
    const stillPinned = [...this.sessions.values()].some((s) => s.sessionId === input.sessionId);
    if (!stillPinned) browserManager.setSessionPinned(input.sessionId, false);
    const wc = this.webContentsFor(input);
    if (wc) {
      await wc
        .executeJavaScript(
          `(() => { if (window.__aegisDesignClearSelection) window.__aegisDesignClearSelection(); if (window.__aegisDesignSetEnabled) window.__aegisDesignSetEnabled(false); return true; })()`,
          true
        )
        .catch(() => undefined);
    }
    this.emit({ kind: 'disabled', sessionId: input.sessionId, tabId: input.tabId, reason });
  }

  private async pollOnce(state: DesignSessionState): Promise<void> {
    const wc = this.webContentsFor(state);
    if (!wc) {
      await this.disable(state, 'page-gone');
      return;
    }
    let raw: unknown = null;
    try {
      raw = await wc.executeJavaScript('window.__aegisDesignDrain ? window.__aegisDesignDrain() : null', true);
    } catch {
      raw = null;
    }
    if (raw === null) {
      // Injection lost (navigation / reload). Re-inject while still on localhost.
      const url = wc.getURL() || '';
      if (!isLocalhostUrl(url)) {
        await this.disable(state, 'left-localhost');
        return;
      }
      try {
        await wc.executeJavaScript(INSPECTOR_SCRIPT, true);
        this.emit({ kind: 'reinjected', sessionId: state.sessionId, tabId: state.tabId });
      } catch {
        // Try again next tick.
      }
      return;
    }
    try {
      const events = JSON.parse(String(raw)) as Array<{ kind: string; info?: DesignSelectionInfo; note?: string }>;
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
          });
        }
      }
    } catch {
      // Malformed drain payload — ignore this tick.
    }
  }

  private async measurePage(wc: WebContents) {
    const raw = (await wc.executeJavaScript(
      'window.__aegisDesignMeasure ? window.__aegisDesignMeasure() : null',
      true
    )) as string | null;
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
    try {
      const measured = await this.measurePage(wc);
      if (!measured) return { found: false };
      return { found: measured.found, rect: measured.rect, viewport: measured.viewport };
    } catch {
      return { found: false };
    }
  }
}

export const designModeService = new DesignModeService();
