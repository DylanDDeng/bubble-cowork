import { BrowserWindow, type WebContentsView } from 'electron';
import type { BrowserViewport } from '../../shared/browser-types';
import { pageBackground, type PageView } from './page-view';

/** Layout size for pages an agent drives while the panel is closed. */
const AGENT_VIEWPORT: BrowserViewport = { x: 0, y: 0, width: 1280, height: 800 };

function detach(host: BrowserWindow | null, view: WebContentsView): void {
  if (!host || host.isDestroyed()) return;
  try {
    if (host.contentView.children.includes(view)) host.contentView.removeChildView(view);
  } catch (error) {
    console.error('[browser] removing a page view failed:', error);
  }
}

function attach(host: BrowserWindow, view: WebContentsView, viewport: BrowserViewport): boolean {
  try {
    if (!host.contentView.children.includes(view)) host.contentView.addChildView(view);
    view.setBounds(viewport);
    return true;
  } catch (error) {
    console.error('[browser] placing a page view failed:', error);
    detach(host, view);
    return false;
  }
}

/**
 * Where native page views live: at most one on the app window (the visible
 * panel), the rest of the agent-driven ones in a hidden window that gives
 * them a real layout. Every add and remove checks the host's child list
 * first: if Electron's list and AppKit's subviews drift apart, the next
 * window resize throws inside AppKit and the app hangs.
 */
export class ViewPlacement {
  private window: BrowserWindow | null = null;
  private agentHost: BrowserWindow | null = null;
  private shown: PageView | null = null;

  get visible(): PageView | null {
    return this.shown;
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.shown && this.window !== window) this.hide();
    this.window = window;
  }

  /** Shows `page` over the panel; showing the page already shown only moves it. */
  show(page: PageView, viewport: BrowserViewport): boolean {
    const window = this.window;
    if (!window || window.isDestroyed() || !page.alive) return false;
    if (this.shown === page) {
      page.view.setBounds(viewport);
      return true;
    }
    this.hide();
    detach(this.agentHost, page.view);
    if (!attach(window, page.view, viewport)) return false;
    this.shown = page;
    return true;
  }

  /** Takes the visible page off the window; returns it so an agent can keep it. */
  hide(): PageView | null {
    const page = this.shown;
    this.shown = null;
    if (page) detach(this.window, page.view);
    return page;
  }

  /** Keeps a page laid out off screen for an agent. */
  park(page: PageView): void {
    if (!page.alive) return;
    if (this.shown === page) this.hide();
    else detach(this.window, page.view);
    attach(this.ensureAgentHost(), page.view, AGENT_VIEWPORT);
  }

  remove(page: PageView): void {
    if (this.shown === page) this.shown = null;
    detach(this.window, page.view);
    detach(this.agentHost, page.view);
  }

  closeAgentHost(): void {
    const host = this.agentHost;
    this.agentHost = null;
    if (!host || host.isDestroyed()) return;
    try {
      host.destroy();
    } catch (error) {
      console.warn('[browser] closing the agent page host failed:', error);
    }
  }

  private ensureAgentHost(): BrowserWindow {
    if (this.agentHost && !this.agentHost.isDestroyed()) return this.agentHost;
    const host = new BrowserWindow({
      show: false,
      width: AGENT_VIEWPORT.width,
      height: AGENT_VIEWPORT.height,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: pageBackground(),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    host.on('closed', () => {
      if (this.agentHost === host) this.agentHost = null;
    });
    this.agentHost = host;
    return host;
  }
}
