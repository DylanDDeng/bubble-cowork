// Per-session in-app browser panel.
//
// Architecture (adapted from dpcode's BrowserPanel.tsx):
// - Main process owns the actual Chromium WebContentsView. This component only
//   renders chrome (address bar, tab strip, buttons) and reserves a viewport
//   div whose bounds are forwarded to the main process so the native view is
//   mirrored on top of the React tree.
// - State is sourced from two places:
//     1. `window.electron.browser.onState` broadcast (live source of truth).
//     2. `useBrowserStateStore` persisted cache (instant paint on session switch).
// - Three AI-integration actions live here:
//     1. Screenshot the active tab and attach to chat.
//     2. Readout the page (text + selection + top links) into the prompt.
//     3. "Send selection to chat" fired from the browser native context menu.
//
// Keep this component resilient to background session switches: we always pass
// the explicit `sessionId` prop to IPC calls and filter onState events.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Palette,
  RefreshCw,
  X,
} from '../icons';
import { toast } from 'sonner';
import type {
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserTabState,
  SessionBrowserState,
} from '../../../shared/browser-types';
import type { Attachment } from '../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import {
  useBrowserStateStore,
  type PersistedBrowserTab,
  type PersistedSessionBrowserState,
} from '../../store/useBrowserStateStore';
import {
  browserAddressDisplayValue,
  normalizeBrowserAddressInput,
  resolveBrowserAddressSync,
  resolveBrowserChromeStatus,
} from './BrowserPanel.logic';

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const DEFAULT_HOME_URL = 'about:blank';
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
  onClose: () => void;
  onWidthChange: (width: number) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  topInset?: number;
  embedded?: boolean;
}

function persistedToState(state: PersistedSessionBrowserState): SessionBrowserState {
  return {
    sessionId: state.sessionId,
    open: true,
    activeTabId: state.activeTabId,
    tabs: state.tabs.map(
      (tab: PersistedBrowserTab): BrowserTabState => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        status: 'suspended',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: tab.faviconUrl,
        lastCommittedUrl: tab.url,
        lastError: null,
      })
    ),
    lastError: null,
  };
}

function stateToPersisted(state: SessionBrowserState): PersistedSessionBrowserState {
  return {
    sessionId: state.sessionId,
    activeTabId: state.activeTabId,
    updatedAt: Date.now(),
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      faviconUrl: tab.faviconUrl,
    })),
  };
}

export function BrowserPanel({
  sessionId,
  browserSessionId: browserSessionIdProp,
  collapsed,
  width,
  onClose,
  onWidthChange,
  isFullscreen,
  onToggleFullscreen,
  topInset = 0,
  embedded = false,
}: BrowserPanelProps) {
  const browserSessionId = browserSessionIdProp ?? sessionId ?? '__standalone-browser__';
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);
  const createDraftSession = useAppStore((s) => s.createDraftSession);
  // Target chat session for "send to chat" actions; create a draft if browsing
  // standalone (no conversation open).
  const resolveChatTargetId = useCallback(
    () => sessionId ?? createDraftSession(),
    [sessionId, createDraftSession]
  );

  const cachedSessionState = useBrowserStateStore(
    (s) => s.sessionStatesBySessionId[browserSessionId] ?? null
  );
  const upsertSessionState = useBrowserStateStore((s) => s.upsertSessionState);
  const removeSessionState = useBrowserStateStore((s) => s.removeSessionState);
  const recordHistoryEntry = useBrowserStateStore((s) => s.recordHistoryEntry);

  const [sessionState, setSessionState] = useState<SessionBrowserState>(() => {
    if (cachedSessionState) return persistedToState(cachedSessionState);
    return {
      sessionId: browserSessionId,
      open: false,
      activeTabId: null,
      tabs: [],
      lastError: null,
    };
  });

  const activeTab = useMemo<BrowserTabState | null>(() => {
    if (!sessionState.activeTabId) return null;
    return sessionState.tabs.find((tab) => tab.id === sessionState.activeTabId) ?? null;
  }, [sessionState]);

  // ===== 地址栏本地编辑状态 =====
  const [addressValue, setAddressValue] = useState('');
  const [addressEditing, setAddressEditing] = useState(false);
  const [addressDrafts, setAddressDrafts] = useState<Record<string, string>>({});
  const lastSyncedAddressRef = useRef<string | undefined>(undefined);
  const previousActiveTabIdRef = useRef<string | null>(null);

  const [localError, setLocalError] = useState<string | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [readoutBusy, setReadoutBusy] = useState(false);

  // ===== Design mode =====
  // The design session is keyed by the (browserSessionId, tabId) it was
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
    const tab = sessionState.activeTabId
      ? sessionState.tabs.find((item) => item.id === sessionState.activeTabId) ?? null
      : null;
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
      sessionState.activeTabId !== designTarget.tabId
    ) {
      disableDesignMode();
    }
  }, [collapsed, browserSessionId, sessionState.activeTabId, designTarget, disableDesignMode]);

  // Unmount cleanup: closing the browser utility tab must release the design
  // session (pin + poll timer + in-page inspector), not leak it.
  useEffect(() => () => disableDesignMode(), [disableDesignMode]);

  // Staleness fingerprint for in-flight enables: any change here (or unmount)
  // invalidates an enable() that resolves afterwards.
  useEffect(() => {
    designContextRef.current = `${collapsed}:${browserSessionId}:${sessionState.activeTabId ?? ''}`;
    return () => {
      designContextRef.current = '__unmounted__';
    };
  }, [collapsed, browserSessionId, sessionState.activeTabId]);

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

    api
      .open({ sessionId: browserSessionId, initialUrl: DEFAULT_HOME_URL })
      .then((state) => {
        if (cancelled) return;
        setSessionState(state);
        upsertSessionState(stateToPersisted(state));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLocalError(String(error));
      });

    const dispose = api.onState((nextState) => {
      if (nextState.sessionId !== browserSessionId) return;
      setSessionState(nextState);
      upsertSessionState(stateToPersisted(nextState));
      const active = nextState.tabs.find((tab) => tab.id === nextState.activeTabId);
      if (active && active.url && active.url !== DEFAULT_HOME_URL) {
        recordHistoryEntry(browserSessionId, {
          url: active.url,
          title: active.title,
          faviconUrl: active.faviconUrl,
          lastVisitedAt: Date.now(),
        });
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [browserSessionId, collapsed, recordHistoryEntry, upsertSessionState]);

  // Pane is hidden but we keep the state alive; tell main to detach.
  useEffect(() => {
    if (!collapsed) return;
    window.electron.browser.hide({ sessionId: browserSessionId }).catch(() => {
      // non-fatal
    });
  }, [browserSessionId, collapsed]);

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

  // ===== 地址栏同步 =====
  const nextDisplayValue = browserAddressDisplayValue(activeTab);
  useEffect(() => {
    const decision = resolveBrowserAddressSync({
      activeTabId: sessionState.activeTabId,
      previousActiveTabId: previousActiveTabIdRef.current,
      savedDraft: sessionState.activeTabId
        ? addressDrafts[sessionState.activeTabId]
        : undefined,
      nextDisplayValue,
      lastSyncedValue: lastSyncedAddressRef.current,
      isEditing: addressEditing,
    });
    previousActiveTabIdRef.current = sessionState.activeTabId;
    if (decision.type === 'replace') {
      setAddressValue(decision.value);
      lastSyncedAddressRef.current = decision.syncedValue;
    }
    // We intentionally omit addressDrafts/addressEditing from deps because the
    // decision layer handles those via ref-like inputs to avoid sync loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState.activeTabId, nextDisplayValue]);

  const chromeStatus = useMemo(
    () =>
      resolveBrowserChromeStatus({
        localError,
        sessionLastError: sessionState.lastError,
        activeTabStatus: activeTab?.status ?? 'suspended',
        hasActiveTab: !!activeTab,
        workspaceReady: sessionState.open,
      }),
    [activeTab, localError, sessionState.lastError, sessionState.open]
  );

  // ===== Viewport bounds sync =====
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const pushBounds = useCallback(() => {
    if (collapsed) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    window.electron.browser
      .setPanelBounds({
        sessionId: browserSessionId,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
      .catch(() => {});
  }, [browserSessionId, collapsed]);

  useLayoutEffect(() => {
    pushBounds();
  }, [pushBounds, width, collapsed]);

  useEffect(() => {
    if (collapsed) return;
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
  }, [collapsed, pushBounds]);

  // When the animation transitions, push bounds repeatedly for a short burst.
  useEffect(() => {
    if (collapsed) return;
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
  }, [collapsed, width, pushBounds]);

  // ===== 操作封装 =====
  const handleNavigate = useCallback(
    async (rawInput: string) => {
      const normalized = normalizeBrowserAddressInput(rawInput);
      try {
        const next = await window.electron.browser.navigate({
          sessionId: browserSessionId,
          tabId: sessionState.activeTabId ?? undefined,
          url: normalized,
        });
        setSessionState(next);
        setAddressEditing(false);
        setLocalError(null);
      } catch (error) {
        setLocalError(String(error));
      }
    },
    [browserSessionId, sessionState.activeTabId]
  );

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleNavigate(addressValue);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setAddressValue(nextDisplayValue);
      setAddressEditing(false);
      (event.target as HTMLInputElement).blur();
    }
  };

  const handleAddressChange = (value: string) => {
    setAddressValue(value);
    if (sessionState.activeTabId) {
      setAddressDrafts((prev) => ({ ...prev, [sessionState.activeTabId!]: value }));
    }
  };

  const handleCloseBrowser = useCallback(() => {
    window.electron.browser
      .close({ sessionId: browserSessionId })
      .then((nextState) => {
        setSessionState(nextState);
        removeSessionState(browserSessionId);
        setAddressDrafts({});
        setLocalError(null);
        onClose();
      })
      .catch((error) => {
        const message = String(error);
        setLocalError(message);
        toast.error(`Failed to close browser: ${message}`);
      });
  }, [browserSessionId, onClose, removeSessionState]);

  const handleBack = () => {
    if (!activeTab) return;
    window.electron.browser.goBack({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };
  const handleForward = () => {
    if (!activeTab) return;
    window.electron.browser.goForward({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };
  const handleReload = () => {
    if (!activeTab) return;
    window.electron.browser.reload({ sessionId: browserSessionId, tabId: activeTab.id }).catch(() => {});
  };

  const handleCaptureScreenshot = async () => {
    if (!activeTab || screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const result = await window.electron.browser.capture({
        sessionId: browserSessionId,
        tabId: activeTab.id,
      });
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
      const note = `Screenshot of [${result.pageTitle || result.pageUrl || activeTab.title}](${
        result.pageUrl || activeTab.url
      })`;
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
    if (!activeTab || readoutBusy) return;
    setReadoutBusy(true);
    try {
      const result = await window.electron.browser.readPage({
        sessionId: browserSessionId,
        tabId: activeTab.id,
      });
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
          <button
            type="button"
            onClick={handleBack}
            disabled={!activeTab?.canGoBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={handleForward}
            disabled={!activeTab?.canGoForward}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={handleReload}
            disabled={!activeTab}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Reload"
            aria-label="Reload"
          >
            <RefreshCw
              className={`h-[13px] w-[13px] ${activeTab?.isLoading ? 'animate-spin' : ''}`}
            />
          </button>

          <div className="relative mx-1 flex-1">
            <input
              type="text"
              spellCheck={false}
              value={addressValue}
              onChange={(e) => handleAddressChange(e.target.value)}
              onFocus={(e) => {
                setAddressEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => {
                window.setTimeout(() => setAddressEditing(false), 100);
              }}
              onKeyDown={handleAddressKeyDown}
              placeholder="Search Google or enter a URL"
              className="h-7 w-full rounded-md border border-transparent bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none focus:ring-1 focus:ring-[var(--border-focus)]"
            />
          </div>

          <button
            type="button"
            onClick={handleCaptureScreenshot}
            disabled={!activeTab || screenshotBusy}
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
            disabled={!activeTab || readoutBusy}
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
            disabled={!activeTab}
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
              if (activeTab?.url) {
                void navigator.clipboard.writeText(activeTab.url);
                toast.success('URL copied');
              }
            }}
            disabled={!activeTab}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Copy URL"
            aria-label="Copy URL"
          >
            <Copy className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (activeTab) {
                window.electron.browser
                  .openDevTools({ sessionId: browserSessionId, tabId: activeTab.id })
                  .catch(() => {});
              }
            }}
            disabled={!activeTab}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            title="Open DevTools"
            aria-label="Open DevTools"
          >
            <MoreHorizontal className="h-[13px] w-[13px]" />
          </button>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="h-[13px] w-[13px]" />
            ) : (
              <Maximize2 className="h-[13px] w-[13px]" />
            )}
          </button>
          <button
            type="button"
            onClick={handleCloseBrowser}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            title="Close browser"
            aria-label="Close browser"
          >
            <X className="h-[13px] w-[13px]" />
          </button>
        </div>

      </div>

      {/* Viewport row: native WebContentsView mirror + (optional) design drawer.
          The drawer shrinks the viewport div; the ResizeObserver above pushes
          the smaller bounds to the main process automatically. */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
          <div ref={viewportRef} className="absolute inset-0" />
          {chromeStatus && (
            <div
              className={`pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border px-2 py-1 text-[11px] ${
                chromeStatus.tone === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-400'
                  : 'border-[var(--border)] bg-[var(--bg-secondary)]/80 text-[var(--text-secondary)]'
              }`}
            >
              {chromeStatus.label}
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
