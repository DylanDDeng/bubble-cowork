import { nativeTheme, WebContentsView, type ContextMenuParams, type WebContents } from 'electron';
import { BROWSER_SESSION_PARTITION } from '../../shared/browser-types';
import type { ViewFacts } from './browser-page';

const ERR_ABORTED = -3;

export type LoadOutcome = 'loaded' | 'aborted' | 'failed' | 'retired';

export interface PageViewEvents {
  /** The view changed what it shows (navigation, title, favicon, loading). */
  facts(facts: ViewFacts): void;
  /** A new main-frame navigation began. */
  started(): void;
  /** A main-frame load failed with a Chromium net error. */
  failed(code: number, url: string): void;
  /** The page asked to open a window. */
  openWindow(url: string): void;
  contextMenu(params: ContextMenuParams): void;
  /** The renderer process died. */
  crashed(): void;
}

let themed: Partial<Record<'light' | 'dark', string>> = {};

/** The app theme's page backgrounds, as last reported by the renderer. */
export function setPageBackgrounds(backgrounds: Partial<Record<'light' | 'dark', string>>): void {
  themed = { ...backgrounds };
}

/** Matches the app's primary background so unpainted areas don't flash white. */
export function pageBackground(): string {
  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return themed[variant] ?? (variant === 'dark' ? '#0e0e0e' : '#ffffff');
}

/**
 * One native page. Once retired it ignores its own late events, so a view
 * being torn down can never write into the state of the view that replaced it.
 */
export class PageView {
  readonly view: WebContentsView;
  private retired = false;

  constructor(private readonly events: PageViewEvents) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.view.setBackgroundColor(pageBackground());
    this.wire(this.view.webContents);
  }

  get contents(): WebContents {
    return this.view.webContents;
  }

  get alive(): boolean {
    return !this.retired && !this.view.webContents.isDestroyed();
  }

  facts(favicons?: string[]): ViewFacts {
    const contents = this.view.webContents;
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canBack: contents.navigationHistory.canGoBack(),
      canForward: contents.navigationHistory.canGoForward(),
      favicons,
    };
  }

  async load(url: string): Promise<LoadOutcome> {
    if (!this.alive) return 'retired';
    try {
      await this.view.webContents.loadURL(url);
      return this.alive ? 'loaded' : 'retired';
    } catch (error) {
      if (!this.alive) return 'retired';
      return error instanceof Error && /ERR_ABORTED|\(-3\)/.test(error.message) ? 'aborted' : 'failed';
    }
  }

  setBackground(color: string): void {
    if (this.alive) this.view.setBackgroundColor(color);
  }

  /** Stops the page and closes its renderer. Callers detach the view first. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      if (contents.isLoading()) contents.stop();
      contents.close({ waitForBeforeUnload: false });
    } catch (error) {
      console.warn('[browser] closing a page failed:', error);
    }
  }

  private wire(contents: WebContents): void {
    const live = <A extends unknown[]>(handler: (...args: A) => void) => (...args: A) => {
      if (!this.retired) handler(...args);
    };
    const report = live(() => this.events.facts(this.facts()));
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.retired) this.events.openWindow(url);
      return { action: 'deny' };
    });
    contents.on('page-title-updated', (event) => {
      event.preventDefault();
      report();
    });
    contents.on('page-favicon-updated', live((_event, favicons: string[]) => this.events.facts(this.facts(favicons))));
    contents.on('did-start-loading', live(() => this.events.started()));
    contents.on('did-stop-loading', report);
    contents.on('did-navigate', report);
    contents.on('did-navigate-in-page', report);
    contents.on(
      'did-fail-load',
      live((_event, code: number, _description: string, url: string, mainFrame: boolean) => {
        if (mainFrame && code !== ERR_ABORTED) this.events.failed(code, url);
      })
    );
    contents.on('context-menu', live((_event, params: ContextMenuParams) => this.events.contextMenu(params)));
    contents.on('render-process-gone', live(() => this.events.crashed()));
  }
}
