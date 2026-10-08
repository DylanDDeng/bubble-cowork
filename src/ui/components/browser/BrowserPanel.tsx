// In-app browser panel for one browser session. The page itself is a native
// view owned by the main process; this component draws the toolbar, reports
// where the page should appear (the viewport div below the toolbar), and
// turns page content into chat context: screenshot, page readout, and
// "Send selection to chat" from the page's context menu.
//
// Every call names the panel's own browser session, and state pushes for
// other sessions are ignored, so a panel switched away mid-request stays
// consistent.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Copy,
  FileText,
  Loader2,
  MoreHorizontal,
  Palette,
  RefreshCw,
} from '../icons';
import { toast } from 'sonner';
import { BLANK_PAGE, resolveAddress } from '../../../shared/browser-address';
import type {
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserSessionState,
} from '../../../shared/browser-types';
import type { Attachment } from '../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import { useBrowserStateStore, type RememberedPage } from '../../store/useBrowserStateStore';
import { browserStatusLine, emptyAddressField, updateAddressField } from './address-bar';
import { useBrowserNativeOverlay } from './browser-native-overlay';

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const READOUT_TEXT_CHAR_LIMIT = 6000;
const READOUT_LINK_LIMIT = 15;

interface BrowserPanelProps {
  // The chat session to inject "send to chat" output into. Null when the
  // browser is used standalone (no conversation open) — in that case the
  // to-chat actions create a new draft conversation on demand.
  sessionId: string | null;
  browserSessionId?: string;
  collapsed: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  topInset?: number;
  embedded?: boolean;
}

/** What the panel shows before the main process reports: the remembered page, suspended. */
function rememberedState(sessionId: string, remembered: RememberedPage | null): BrowserSessionState {
  return {
    sessionId,
    open: !!remembered,
    agentActive: false,
    page: remembered
      ? {
          id: remembered.pageId,
          url: remembered.url,
          title: remembered.title,
          phase: 'suspended',
          loading: false,
          canBack: false,
          canForward: false,
          favicon: remembered.favicon,
          committedUrl: remembered.url,
          error: null,
        }
      : null,
  };
}

export function BrowserPanel({
  sessionId,
  browserSessionId: browserSessionIdProp,
  collapsed,
  width,
  onWidthChange,
  isFullscreen,
  onToggleFullscreen,
  topInset = 0,
  embedded = false,
}: BrowserPanelProps) {
  const browserSessionId = browserSessionIdProp ?? sessionId ?? '__standalone-browser__';
  const overlayOpen = useBrowserNativeOverlay();
  const nativeViewHidden = collapsed || overlayOpen;
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);
  const createDraftSession = useAppStore((s) => s.createDraftSession);
  // Target chat session for "send to chat" actions; create a draft if browsing
  // standalone (no conversation open).
  const resolveChatTargetId = useCallback(
    () => sessionId ?? createDraftSession(),
    [sessionId, createDraftSession]
  );

  const rememberPage = useBrowserStateStore((s) => s.remember);
  const [sessionState, setSessionState] = useState<BrowserSessionState>(() =>
    rememberedState(browserSessionId, useBrowserStateStore.getState().pages[browserSessionId] ?? null)
  );
  const page = sessionState.page;
  const [address, dispatchAddress] = useReducer(updateAddressField, emptyAddressField);
  useEffect(() => dispatchAddress({ kind: 'page', page }), [page]);

  const [localError, setLocalError] = useState<string | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [readoutBusy, setReadoutBusy] = useState(false);

  // ===== Design mode =====
  // The design session is keyed by the (browserSessionId, page id) it was
  // ENABLED for — disable must use that stored pair, not the current props:
  // after a chat-session switch browserSessionId changes and a disable built
  // from it would miss the service's session map, leaking the pinned
  // WebContentsView and leaving the page's clicks hijacked by the inspector
  // (review finding).
  const [designTarget, setDesignTarget] = useState<{ browserSessionId: string; tabId: string; token?: number } | null>(null);
  const projectRoot = useAppStore((s) => (sessionId ? s.sessions[sessionId]?.cwd ?? null : null));

  const disableDesignMode = useCallback(() => {
    setDesignTarget((current) => {
      if (current) {
        void window.electron.designMode.disable({
          sessionId: current.browserSessionId,
          tabId: current.tabId,
          token: current.token,
        });
      }
      return null;
    });
  }, []);

  // The enable round-trip (inject + probe) is slow enough for the user to
  // collapse the panel or switch tabs mid-flight; a resolved enable must not
  // record a target the cleanup effects have already stopped watching, or
  // the pinned session + click-hijacking inspector leak (codex review).
  const designContextRef = useRef('');
  const toggleDesignMode = useCallback(async () => {
    if (designTarget) {
      disableDesignMode();
      return;
    }
    const tab = sessionState.page;
    if (!tab) return;
    if (!projectRoot) {
      toast.error('Design mode needs an open project session (annotations carry project context).');
      return;
    }
    const contextAtStart = designContextRef.current;
    const enabled = await window.electron.designMode.enable({
      sessionId: browserSessionId,
      tabId: tab.id,
      projectRoot,
    });
    if (!enabled.ok) {
      toast.error(enabled.message || 'Failed to enable design mode');
      return;
    }
    if (designContextRef.current !== contextAtStart) {
      // Panel collapsed / tab or session switched while enable was in flight.
      // Token-scoped: this must tear down OUR stale session only, never a
      // successor a reopened panel installed under the same key.
      void window.electron.designMode.disable({ sessionId: browserSessionId, tabId: tab.id, token: enabled.token });
      return;
    }
    setDesignTarget({ browserSessionId, tabId: tab.id, token: enabled.token });
  }, [designTarget, disableDesignMode, sessionState, projectRoot, browserSessionId]);

  // Design mode is bound to one tab of one browser session: leaving it in
  // ANY direction (tab switch, chat-session switch, panel collapse) ends the
  // design session explicitly.
  useEffect(() => {
    if (!designTarget) return;
    if (
      collapsed ||
      browserSessionId !== designTarget.browserSessionId ||
      page?.id !== designTarget.tabId
    ) {
      disableDesignMode();
    }
  }, [collapsed, browserSessionId, page?.id, designTarget, disableDesignMode]);

  // Unmount cleanup: closing the browser utility tab must release the design
  // session (pin + poll timer + in-page inspector), not leak it.
  useEffect(() => () => disableDesignMode(), [disableDesignMode]);

  // Staleness fingerprint for in-flight enables: any change here (or unmount)
  // invalidates an enable() that resolves afterwards.
  useEffect(() => {
    designContextRef.current = `${collapsed}:${browserSessionId}:${page?.id ?? ''}`;
    return () => {
      designContextRef.current = '__unmounted__';
    };
  }, [collapsed, browserSessionId, page?.id]);

  // The service emits 'disabled' when it tears a session down (page gone,
  // left localhost, host reload); clear the UI target without re-invoking
  // IPC (idempotent server-side). Annotate delivery lives in the app-level
  // DesignAnnotateBridge, independent of this panel's lifetime.
  useEffect(() => {
    return window.electron.designMode.onEvent((event) => {
      if (event.kind !== 'disabled') return;
      setDesignTarget((current) =>
        current && current.tabId === event.tabId && current.browserSessionId === event.sessionId
          ? null
          : current
      );
    });
  }, []);

  // ===== 订阅主进程状态 =====
  useEffect(() => {
    if (collapsed) return;

    let cancelled = false;
    const api = window.electron.browser;

    const accept = (state: BrowserSessionState) => {
      setSessionState(state);
      rememberPage(state);
    };
    api
      .open({ sessionId: browserSessionId, initialUrl: BLANK_PAGE })
      .then((state) => {
        if (!cancelled) accept(state);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLocalError(String(error));
      });
    const dispose = api.onState((state) => {
      if (state.sessionId === browserSessionId) accept(state);
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [browserSessionId, collapsed, rememberPage]);

  // Invalidate scheduled geometry updates before paint. Otherwise an old
  // ResizeObserver/rAF can reattach a view after navigation has hidden it.
  const nativeViewActiveRef = useRef(false);
  useLayoutEffect(() => {
    nativeViewActiveRef.current = !nativeViewHidden;
    const hide = () => {
      window.electron.browser.hide({ sessionId: browserSessionId }).catch(() => {});
    };
    if (nativeViewHidden) hide();
    return () => {
      nativeViewActiveRef.current = false;
      // Detach in the same commit as the session change, keeping page state.
      hide();
    };
  }, [browserSessionId, nativeViewHidden]);

  // ===== Context menu -> send selection to chat =====
  useEffect(() => {
    const api = window.electron.browser;
    const dispose = api.onSendSelection((event: BrowserSendSelectionEvent) => {
      if (event.sessionId !== browserSessionId) return;
      const quoted = event.selectionText
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const text = `From [${event.pageTitle || event.pageUrl}](${event.pageUrl}):\n\n${quoted}`;
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text,
        mode: 'append',
        source: 'browser:selection',
      });
      toast.success('Selection sent to chat');
    });
    return () => dispose();
  }, [browserSessionId, requestChatInjection, sessionId]);

  const statusLine = useMemo(
    () => browserStatusLine({ localError, page, open: sessionState.open }),
    [localError, page, sessionState.open]
  );

  // ===== Viewport bounds sync =====
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const pushBounds = useCallback(() => {
    if (nativeViewHidden || !nativeViewActiveRef.current) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    window.electron.browser
      .setPanelBounds({
        sessionId: browserSessionId,
        viewport: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
      .catch(() => {});
  }, [browserSessionId, nativeViewHidden]);

  useLayoutEffect(() => {
    pushBounds();
  }, [pushBounds, width, nativeViewHidden]);

  useEffect(() => {
    if (nativeViewHidden) return;
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        pushBounds();
      });
    });
    observer.observe(el);
    const onWindowResize = () => pushBounds();
    window.addEventListener('resize', onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [nativeViewHidden, pushBounds]);

  // When the animation transitions, push bounds repeatedly for a short burst.
  useEffect(() => {
    if (nativeViewHidden) return;
    let frames = 0;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      pushBounds();
      frames += 1;
      if (frames < 18) {
        requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
    return () => {
      stopped = true;
    };
  }, [nativeViewHidden, width, pushBounds]);

  // ===== Toolbar actions =====
  const handleNavigate = useCallback(
    async (typed: string) => {
      try {
        const next = await window.electron.browser.navigate({
          sessionId: browserSessionId,
          url: resolveAddress(typed),
        });
        setSessionState(next);
        dispatchAddress({ kind: 'submitted' });
        setLocalError(null);
      } catch (error) {
        setLocalError(String(error));
      }
    },
    [browserSessionId]
  );

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleNavigate(address.text);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dispatchAddress({ kind: 'cancel' });
      event.currentTarget.blur();
    }
  };

  const pageCall = (call: (input: { sessionId: string }) => Promise<unknown>) => () => {
    if (page) call({ sessionId: browserSessionId }).catch(() => {});
  };
  const handleBack = pageCall(window.electron.browser.goBack);
  const handleForward = pageCall(window.electron.browser.goForward);
  const handleReload = pageCall(window.electron.browser.reload);

  const handleCaptureScreenshot = async () => {
    if (!page || screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const result = await window.electron.browser.capture({ sessionId: browserSessionId });
      if (!result.ok || !result.base64) {
        toast.error(result.message || 'Failed to capture screenshot');
        return;
      }
      const bytes = base64ToBytes(result.base64);
      const mimeType = result.mimeType || 'image/png';
      const attachment = (await window.electron.createInlineImageAttachment(
        mimeType,
        bytes
      )) as Attachment | null;
      if (!attachment) {
        toast.error('Failed to create screenshot attachment');
        return;
      }
      const note = `Screenshot of [${result.pageTitle || result.pageUrl || page.title}](${result.pageUrl || page.url})`;
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text: note,
        attachments: [attachment],
        mode: 'append',
        source: 'browser:screenshot',
      });
      toast.success('Screenshot added to chat');
    } catch (error) {
      toast.error(`Failed to capture screenshot: ${error}`);
    } finally {
      setScreenshotBusy(false);
    }
  };

  const handleReadPage = async () => {
    if (!page || readoutBusy) return;
    setReadoutBusy(true);
    try {
      const result = await window.electron.browser.readPage({ sessionId: browserSessionId });
      if (!result.ok) {
        toast.error(result.message || 'Failed to read this page');
        return;
      }
      const text = formatReadoutText(result);
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text,
        mode: 'append',
        source: 'browser:readout',
      });
      toast.success('Page content sent to chat');
    } catch (error) {
      toast.error(`Failed to read page: ${error}`);
    } finally {
      setReadoutBusy(false);
    }
  };

  // ===== 面板尺寸拖拽 =====
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - event.clientX;
      const next = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, startWidthRef.current + delta)
      );
      onWidthChange(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [isResizing, onWidthChange]);

  // Esc exits fullscreen. Only binds when in fullscreen so we don't swallow
  // Escape elsewhere (address bar blur, modal close, etc.).
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onToggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, onToggleFullscreen]);

  // ===== Render =====
  return (
    <div
      className={
        embedded
          ? `absolute inset-0 min-h-0 min-w-0 bg-[var(--bg-primary)] ${
              collapsed ? 'hidden' : 'flex flex-col'
            }`
          : `relative flex h-full flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] transition-[width,opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isFullscreen ? 'flex-1 min-w-0' : 'flex-shrink-0'
            } ${collapsed && !isFullscreen ? 'pointer-events-none' : ''}`
      }
      style={
        embedded
          ? undefined
          : isFullscreen
          ? {
              width: 'auto',
              opacity: 1,
              transform: 'translateX(0)',
              borderLeftWidth: 1,
            }
          : {
              width: collapsed ? 0 : width,
              opacity: collapsed ? 0 : 1,
              transform: collapsed ? 'translateX(18px)' : 'translateX(0)',
              borderLeftWidth: collapsed ? 0 : 1,
            }
      }
      aria-hidden={collapsed && !isFullscreen}
    >
      {!embedded && !collapsed && !isFullscreen && (
        <div
          className="group absolute left-0 top-0 bottom-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
        </div>
      )}

      {/* Top drag strip */}
      {!embedded ? (
        <div
          className="drag-region flex-shrink-0"
          style={{ height: topInset > 0 ? topInset : 32 }}
        />
      ) : null}

      {/* Chrome */}
      <div className="no-drag flex-shrink-0 bg-[var(--bg-secondary)]/45">
        <div className="flex items-center gap-1 px-2 py-1.5">
          {sessionState.agentActive ? (
            <span
              className="mr-0.5 inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent-light)] px-2 text-[11px] font-medium text-[var(--accent)]"
              title="An agent is driving this browser panel"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              </span>
              Agent
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleBack}
            disabled={!page?.canBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={handleForward}
            disabled={!page?.canForward}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={handleReload}
            disabled={!page}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Reload"
            aria-label="Reload"
          >
            <RefreshCw
              className={`h-[13px] w-[13px] ${page?.loading ? 'animate-spin' : ''}`}
            />
          </button>

          <div className="relative mx-1 flex-1">
            <input
              type="text"
              spellCheck={false}
              value={address.text}
              onChange={(e) => dispatchAddress({ kind: 'type', text: e.target.value })}
              onFocus={(e) => {
                dispatchAddress({ kind: 'focus' });
                e.currentTarget.select();
              }}
              onBlur={() => {
                window.setTimeout(() => dispatchAddress({ kind: 'blur' }), 100);
              }}
              onKeyDown={handleAddressKeyDown}
              placeholder="Search Google or enter a URL"
              className="h-7 w-full rounded-md border border-transparent bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            />
          </div>

          <button
            type="button"
            onClick={handleCaptureScreenshot}
            disabled={!page || screenshotBusy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Screenshot to chat"
            aria-label="Screenshot to chat"
          >
            {screenshotBusy ? (
              <Loader2 className="h-[13px] w-[13px] animate-spin" />
            ) : (
              <Camera className="h-[13px] w-[13px]" />
            )}
          </button>
          <button
            type="button"
            onClick={handleReadPage}
            disabled={!page || readoutBusy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Send page content to chat"
            aria-label="Send page content to chat"
          >
            {readoutBusy ? (
              <Loader2 className="h-[13px] w-[13px] animate-spin" />
            ) : (
              <FileText className="h-[13px] w-[13px]" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void toggleDesignMode()}
            disabled={!page}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
              designTarget
                ? 'bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
            }`}
            title={designTarget ? 'Exit design mode' : 'Design mode: click an element, describe the change, send it to the agent'}
            aria-label="Toggle design mode"
          >
            <Palette className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (page?.url) {
                void navigator.clipboard.writeText(page.url);
                toast.success('URL copied');
              }
            }}
            disabled={!page}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Copy URL"
            aria-label="Copy URL"
          >
            <Copy className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (page) window.electron.browser.openDevTools({ sessionId: browserSessionId }).catch(() => {});
            }}
            disabled={!page}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Open DevTools"
            aria-label="Open DevTools"
          >
            <MoreHorizontal className="h-[13px] w-[13px]" />
          </button>
        </div>

      </div>

      {/* Viewport row: native WebContentsView mirror + (optional) design drawer.
          The drawer shrinks the viewport div; the ResizeObserver above pushes
          the smaller bounds to the main process automatically. */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
          <div ref={viewportRef} className="absolute inset-0" />
          {statusLine && (
            <div
              className={`pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border px-2 py-1 text-[11px] ${
                statusLine.tone === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-400'
                  : 'border-[var(--border)] bg-[var(--bg-secondary)]/80 text-[var(--text-secondary)]'
              }`}
            >
              {statusLine.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function formatReadoutText(result: BrowserReadoutResult): string {
  const lines: string[] = [];
  lines.push(`Context from [${result.title || result.url || 'page'}](${result.url || ''})`);
  if (result.selection && result.selection.trim().length > 0) {
    lines.push('\nSelected text:');
    lines.push(result.selection.trim());
  }
  if (result.text && result.text.trim().length > 0) {
    const body = result.text.trim().slice(0, READOUT_TEXT_CHAR_LIMIT);
    lines.push('\nPage text:');
    lines.push(body);
    if (result.text.length > READOUT_TEXT_CHAR_LIMIT) {
      lines.push(`\n(Truncated to first ${READOUT_TEXT_CHAR_LIMIT} characters)`);
    }
  }
  if (result.links && result.links.length > 0) {
    const items = result.links.slice(0, READOUT_LINK_LIMIT);
    lines.push('\nTop links:');
    for (const link of items) {
      lines.push(`- [${link.text.trim() || link.url}](${link.url})`);
    }
  }
  return lines.join('\n');
}
