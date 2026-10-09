// In-app browser panel for one browser session. The page itself is a native
// view owned by the main process; this component draws the toolbar, reports
// where the page should appear (the viewport div below the toolbar), and
// turns page content into chat context: screenshot, page readout, and
// "Send selection to chat" from the page's context menu.
//
// Every call names the panel's own browser session, and state pushes for
// other sessions are ignored, so a panel switched away mid-request stays
// consistent.
//
// The native page always paints above the DOM, so anything the panel draws
// over the page area (the start view, the error view) takes the page off
// screen while it shows.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  MoreHorizontal,
  Palette,
  RefreshCw,
  Search,
  X,
} from '../icons';
import { toast } from 'sonner';
import { BLANK_PAGE, resolveAddress } from '../../../shared/browser-address';
import type {
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserSessionState,
} from '../../../shared/browser-types';
import { isMacPlatform } from '../../../shared/keyboard-shortcuts';
import type { Attachment } from '../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import { useBrowserStateStore, type RememberedPage } from '../../store/useBrowserStateStore';
import {
  browserStatusLine,
  emptyAddressField,
  pageOverlayFor,
  panelShortcutFor,
  recentPages,
  siteMarkFor,
  updateAddressField,
} from './address-bar';
import { useBrowserNativeOverlay } from './browser-native-overlay';

const READOUT_TEXT_CHAR_LIMIT = 6000;
const READOUT_LINK_LIMIT = 15;
/** Below this toolbar width, screenshot and annotate move into the menu. */
const COMPACT_TOOLBAR_WIDTH = 460;

interface BrowserPanelProps {
  // The chat session to inject "send to chat" output into. Null when the
  // browser is used standalone (no conversation open) — in that case the
  // to-chat actions create a new draft conversation on demand.
  sessionId: string | null;
  browserSessionId?: string;
  collapsed: boolean;
  /** Width of the panel; changes re-measure where the page goes. */
  width: number;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
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
          zoom: 1,
        }
      : null,
  };
}

const toolbarButtonClass =
  'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]';

function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  children,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`${toolbarButtonClass} ${
        active ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] hover:text-[var(--accent)]' : ''
      }`}
    >
      {children}
    </button>
  );
}

/** Favicon or a fitting mark at the start of the address bar. */
function SiteMark({ page }: { page: BrowserSessionState['page'] }) {
  const [broken, setBroken] = useState(false);
  const mark = siteMarkFor(page);
  useEffect(() => setBroken(false), [page?.favicon]);
  const iconClass = 'h-[13px] w-[13px] flex-shrink-0';
  if (mark === 'favicon' && page?.favicon && !broken) {
    return <img src={page.favicon} alt="" className="h-[14px] w-[14px] flex-shrink-0 rounded-[3px]" onError={() => setBroken(true)} />;
  }
  if (mark === 'error') return <AlertTriangle className={`${iconClass} text-[var(--warning)]`} aria-hidden="true" />;
  if (mark === 'file') return <FileText className={`${iconClass} text-[var(--text-muted)]`} aria-hidden="true" />;
  if (mark === 'search') return <Search className={`${iconClass} text-[var(--text-muted)]`} aria-hidden="true" />;
  return <Globe className={`${iconClass} text-[var(--text-muted)]`} aria-hidden="true" />;
}

export function BrowserPanel({
  sessionId,
  browserSessionId: browserSessionIdProp,
  collapsed,
  width,
  isFullscreen,
  onToggleFullscreen,
}: BrowserPanelProps) {
  const browserSessionId = browserSessionIdProp ?? sessionId ?? '__standalone-browser__';
  const overlayOpen = useBrowserNativeOverlay();
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);
  const createDraftSession = useAppStore((s) => s.createDraftSession);
  // Target chat session for "send to chat" actions; create a draft if browsing
  // standalone (no conversation open).
  const resolveChatTargetId = useCallback(
    () => sessionId ?? createDraftSession(),
    [sessionId, createDraftSession]
  );

  const rememberPage = useBrowserStateStore((s) => s.remember);
  const rememberedPages = useBrowserStateStore((s) => s.pages);
  const [sessionState, setSessionState] = useState<BrowserSessionState>(() =>
    rememberedState(browserSessionId, useBrowserStateStore.getState().pages[browserSessionId] ?? null)
  );
  const page = sessionState.page;
  const [address, dispatchAddress] = useReducer(updateAddressField, emptyAddressField);
  useEffect(() => dispatchAddress({ kind: 'page', page }), [page]);

  const [localError, setLocalError] = useState<string | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [readoutBusy, setReadoutBusy] = useState(false);

  const pageOverlay = pageOverlayFor(page, sessionState.agentActive);
  const nativeViewHidden = collapsed || overlayOpen || pageOverlay !== null;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(Number.POSITIVE_INFINITY);
  const compact = toolbarWidth < COMPACT_TOOLBAR_WIDTH;

  // ===== Design mode =====
  // The design session is keyed by the (browserSessionId, page id) it was
  // ENABLED for — disable must use that stored pair, not the current props:
  // after a chat-session switch browserSessionId changes and a disable built
  // from it would miss the service's session map, leaking the pinned
  // WebContentsView and leaving the page's clicks hijacked by the inspector
  // (review finding).
  const [designTarget, setDesignTarget] = useState<{ browserSessionId: string; tabId: string; token?: number } | null>(null);
  /** Annotations sent to the composer during this design session. */
  const [annotationCount, setAnnotationCount] = useState(0);
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
    const contextAtStart = designContextRef.current;
    // Any web page can be annotated; a project only adds source context.
    const enabled = await window.electron.designMode.enable({
      sessionId: browserSessionId,
      tabId: tab.id,
      projectRoot: projectRoot ?? '',
    });
    if (!enabled.ok) {
      toast.error(enabled.message || 'Failed to start annotating');
      return;
    }
    if (designContextRef.current !== contextAtStart) {
      // Panel collapsed / tab or session switched while enable was in flight.
      // Token-scoped: this must tear down OUR stale session only, never a
      // successor a reopened panel installed under the same key.
      void window.electron.designMode.disable({ sessionId: browserSessionId, tabId: tab.id, token: enabled.token });
      return;
    }
    setAnnotationCount(0);
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
  // left the web, host reload); clear the UI target without re-invoking IPC
  // (idempotent server-side). Annotate delivery lives in the app-level
  // DesignAnnotateBridge, independent of this panel's lifetime; the panel
  // only counts what this session added.
  useEffect(() => {
    return window.electron.designMode.onEvent((event) => {
      if (event.kind === 'annotate' && event.sessionId === browserSessionId) {
        setAnnotationCount((count) => count + 1);
        return;
      }
      if (event.kind !== 'disabled') return;
      setDesignTarget((current) =>
        current && current.tabId === event.tabId && current.browserSessionId === event.sessionId
          ? null
          : current
      );
    });
  }, [browserSessionId]);

  // ===== 订阅主进程状态 =====
  useEffect(() => {
    if (collapsed) return;

    let cancelled = false;
    const api = window.electron.browser;

    const accept = (state: BrowserSessionState) => {
      setSessionState(state);
      rememberPage(state);
    };
    // The main process keeps a live page as it is; the initial address only
    // seeds a new one, so after an app restart the panel comes back on the
    // page it last showed instead of a blank one.
    const remembered = useBrowserStateStore.getState().pages[browserSessionId];
    api
      .open({ sessionId: browserSessionId, initialUrl: remembered?.url || BLANK_PAGE })
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
  }, [browserSessionId, requestChatInjection, resolveChatTargetId]);

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

  // When the panel transitions in, push bounds repeatedly for a short burst.
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

  // Toolbar width decides which actions stay visible.
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => setToolbarWidth(entries[0]?.contentRect.width ?? Number.POSITIVE_INFINITY));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
        addressInputRef.current?.blur();
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
  const handleStop = pageCall(window.electron.browser.stop);
  const handleRetry = () => {
    if (!page) return;
    void handleNavigate(page.url);
  };
  const handleOpenExternal = () => {
    if (page && /^https?:\/\//i.test(page.url)) void window.electron.openExternalUrl(page.url).catch(() => {});
  };

  const focusAddress = useCallback(() => {
    const input = addressInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const handleCaptureScreenshot = useCallback(async () => {
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
  }, [page, screenshotBusy, browserSessionId, requestChatInjection, resolveChatTargetId]);

  const handleReadPage = useCallback(async () => {
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
  }, [page, readoutBusy, browserSessionId, requestChatInjection, resolveChatTargetId]);

  const openMenu = () => {
    const button = menuButtonRef.current;
    if (!button || !page) return;
    const rect = button.getBoundingClientRect();
    void window.electron.browser
      .showMenu({
        sessionId: browserSessionId,
        x: rect.right - 220,
        y: rect.bottom + 4,
        compact,
        annotating: Boolean(designTarget),
      })
      .catch(() => {});
  };

  // ===== Find in page =====
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<{ active: number; matches: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const openFind = useCallback(() => {
    if (!page) return;
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [page]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    window.electron.browser.stopFind({ sessionId: browserSessionId }).catch(() => {});
  }, [browserSessionId]);

  const runFind = (text: string, options: { findNext?: boolean; backward?: boolean } = {}) => {
    window.electron.browser
      .find({ sessionId: browserSessionId, text, findNext: options.findNext, backward: options.backward })
      .catch(() => {});
    if (!text) setFindResult(null);
  };

  useEffect(() => {
    return window.electron.browser.onFindResult((result) => {
      if (result.sessionId === browserSessionId) setFindResult({ active: result.active, matches: result.matches });
    });
  }, [browserSessionId]);

  // A collapsed or switched-away panel leaves no highlight behind.
  useEffect(() => {
    if (collapsed && findOpen) closeFind();
  }, [collapsed, findOpen, closeFind]);

  // ===== Commands from the page's keyboard and the native menu =====
  useEffect(() => {
    return window.electron.browser.onCommand((event) => {
      if (event.sessionId !== browserSessionId || collapsed) return;
      if (event.command === 'focus-address') focusAddress();
      else if (event.command === 'find') openFind();
      else if (event.command === 'screenshot') void handleCaptureScreenshot();
      else if (event.command === 'readout') void handleReadPage();
      else if (event.command === 'annotate') void toggleDesignMode();
    });
  }, [browserSessionId, collapsed, focusAddress, openFind, handleCaptureScreenshot, handleReadPage, toggleDesignMode]);

  // Keys while the panel's own controls have focus. Claimed keys are kept
  // from the app keymap (it skips prevented events).
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const action = panelShortcutFor(event, isMacPlatform());
    if (!action) return;
    event.preventDefault();
    if (action === 'focus-address') focusAddress();
    else if (action === 'find') openFind();
    else if (action === 'back') handleBack();
    else if (action === 'forward') handleForward();
  };

  // The app menu's Reload/Zoom act on this page while the panel's controls
  // have focus (the page claims those keys itself when it has focus).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = () => {
      window.electron.browser.setChromeFocus({ sessionId: browserSessionId }).catch(() => {});
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
      window.electron.browser.setChromeFocus({ sessionId: null }).catch(() => {});
    };
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      if (root.contains(document.activeElement)) {
        window.electron.browser.setChromeFocus({ sessionId: null }).catch(() => {});
      }
    };
  }, [browserSessionId]);

  // Esc exits fullscreen. Only binds when in fullscreen so we don't swallow
  // Escape elsewhere (address bar blur, modal close, etc.).
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        onToggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, onToggleFullscreen]);

  const zoomPercent = Math.round((page?.zoom ?? 1) * 100);
  const recent = useMemo(
    () => (pageOverlay === 'empty' ? recentPages(rememberedPages, browserSessionId) : []),
    [pageOverlay, rememberedPages, browserSessionId]
  );

  // ===== Render =====
  return (
    <div
      ref={rootRef}
      onKeyDown={handlePanelKeyDown}
      className={`absolute inset-0 min-h-0 min-w-0 bg-[var(--bg-primary)] ${collapsed ? 'hidden' : 'flex flex-col'}`}
    >
      {/* Toolbar */}
      <div
        ref={toolbarRef}
        className="no-drag relative flex h-10 flex-shrink-0 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--bg-secondary)]/45 px-1.5"
      >
        {sessionState.agentActive ? (
          <span
            className="mr-1 inline-flex h-6 flex-shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent-light)] px-2 text-[11px] font-medium text-[var(--accent)]"
            title="An agent is using this page"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            </span>
            Agent
          </span>
        ) : null}
        <ToolbarButton label="Back" onClick={handleBack} disabled={!page?.canBack}>
          <ArrowLeft className="h-[14px] w-[14px]" />
        </ToolbarButton>
        <ToolbarButton label="Forward" onClick={handleForward} disabled={!page?.canForward}>
          <ArrowRight className="h-[14px] w-[14px]" />
        </ToolbarButton>
        {page?.loading ? (
          <ToolbarButton label="Stop loading" onClick={handleStop}>
            <X className="h-[14px] w-[14px]" />
          </ToolbarButton>
        ) : (
          <ToolbarButton label="Reload" onClick={handleReload} disabled={!page}>
            <RefreshCw className="h-[14px] w-[14px]" />
          </ToolbarButton>
        )}

        {/* Address bar */}
        <div className="group/address relative mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent bg-[var(--bg-tertiary)] pl-2 pr-1 focus-within:border-[var(--border-focus)] focus-within:ring-1 focus-within:ring-[var(--border-focus)]">
          <SiteMark page={page} />
          <input
            ref={addressInputRef}
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
            placeholder="Search or enter address"
            aria-label="Address"
            className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          {zoomPercent !== 100 ? (
            <button
              type="button"
              onClick={() => void window.electron.browser.zoom({ sessionId: browserSessionId, direction: 'reset' })}
              title="Reset zoom"
              className="flex-shrink-0 rounded px-1 text-[10px] font-medium tabular-nums text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            >
              {zoomPercent}%
            </button>
          ) : null}
          {page && /^https?:\/\//i.test(page.url) ? (
            <button
              type="button"
              onClick={handleOpenExternal}
              title="Open in default browser"
              aria-label="Open in default browser"
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/address:opacity-100"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          ) : null}
        </div>

        {!compact ? (
          <>
            <ToolbarButton label="Screenshot to chat" onClick={() => void handleCaptureScreenshot()} disabled={!page || screenshotBusy}>
              {screenshotBusy ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Camera className="h-[14px] w-[14px]" />}
            </ToolbarButton>
            <div className="relative flex-shrink-0">
              <ToolbarButton
                label={designTarget ? 'Stop annotating' : 'Annotate: click an element or drag over an area, describe the change'}
                onClick={() => void toggleDesignMode()}
                disabled={!page || pageOverlay !== null}
                active={Boolean(designTarget)}
              >
                <Palette className="h-[14px] w-[14px]" />
              </ToolbarButton>
              {designTarget && annotationCount > 0 ? (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-semibold leading-none text-white">
                  {annotationCount}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
        <ToolbarButton label="More" onClick={openMenu} disabled={!page} buttonRef={menuButtonRef}>
          <MoreHorizontal className="h-[14px] w-[14px]" />
        </ToolbarButton>

        {/* Loading: a thin sweep along the toolbar's bottom edge. */}
        <div
          className={`pointer-events-none absolute inset-x-0 -bottom-px h-[2px] overflow-hidden transition-opacity duration-200 ${
            page?.loading ? 'opacity-100' : 'opacity-0'
          }`}
          role="progressbar"
          aria-label="Loading"
          aria-hidden={!page?.loading}
        >
          {page?.loading ? <div className="aegis-browser-progress h-full w-1/3 bg-[var(--accent)]" /> : null}
        </div>
      </div>

      {/* Find in page */}
      {findOpen ? (
        <div className="no-drag flex h-9 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)]/45 px-2">
          <Search className="h-[13px] w-[13px] flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <input
            ref={findInputRef}
            type="text"
            spellCheck={false}
            value={findText}
            aria-label="Find in page"
            data-browser-find=""
            placeholder="Find in page"
            onChange={(event) => {
              setFindText(event.target.value);
              runFind(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runFind(findText, { findNext: true, backward: event.shiftKey });
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <span className="flex-shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]" aria-live="polite">
            {findText && findResult ? (findResult.matches ? `${findResult.active}/${findResult.matches}` : 'No results') : ''}
          </span>
          <ToolbarButton label="Previous match" onClick={() => runFind(findText, { findNext: true, backward: true })} disabled={!findResult?.matches}>
            <ChevronUp className="h-[14px] w-[14px]" />
          </ToolbarButton>
          <ToolbarButton label="Next match" onClick={() => runFind(findText, { findNext: true })} disabled={!findResult?.matches}>
            <ChevronDown className="h-[14px] w-[14px]" />
          </ToolbarButton>
          <ToolbarButton label="Close find" onClick={closeFind}>
            <X className="h-[14px] w-[14px]" />
          </ToolbarButton>
        </div>
      ) : null}

      {/* Page area: the native page is laid over viewportRef. */}
      <div className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
        <div ref={viewportRef} className="absolute inset-0" />
        {pageOverlay === 'empty' ? (
          <StartView
            recent={recent}
            onOpen={(url) => void handleNavigate(url)}
            onFocusAddress={focusAddress}
          />
        ) : null}
        {pageOverlay === 'error' && page ? (
          <ErrorView
            message={page.error ?? ''}
            url={page.url}
            onRetry={handleRetry}
            onOpenExternal={/^https?:\/\//i.test(page.url) ? handleOpenExternal : null}
          />
        ) : null}
        {statusLine ? (
          <div
            className={`pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border px-2 py-1 text-[11px] ${
              statusLine.tone === 'error'
                ? 'border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)]/80 text-[var(--text-secondary)]'
            }`}
          >
            {statusLine.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StartView({
  recent,
  onOpen,
  onFocusAddress,
}: {
  recent: Array<{ url: string; title: string; favicon: string | null }>;
  onOpen: (url: string) => void;
  onFocusAddress: () => void;
}) {
  const shortcut = isMacPlatform() ? '⌘L' : 'Ctrl+L';
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-[340px] flex-col items-center text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Globe className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">Start browsing</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          <button type="button" onClick={onFocusAddress} className="underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--text-primary)]">
            Type an address or a search
          </button>{' '}
          in the bar above ({shortcut}). Local dev servers work too, like localhost:5173.
        </p>
        {recent.length ? (
          <div className="mt-5 w-full text-left">
            <div className="px-2 pb-1 text-[11px] font-medium text-[var(--text-muted)]">Recent</div>
            <ul className="flex flex-col">
              {recent.map((item) => (
                <li key={item.url}>
                  <button
                    type="button"
                    onClick={() => onOpen(item.url)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--sidebar-item-hover)]"
                    title={item.url}
                  >
                    <RecentMark favicon={item.favicon} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{item.title || hostOf(item.url)}</span>
                    <span className="max-w-[45%] flex-shrink-0 truncate text-[11px] text-[var(--text-muted)]">{hostOf(item.url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RecentMark({ favicon }: { favicon: string | null }) {
  const [broken, setBroken] = useState(false);
  if (favicon && /^(https?:|data:image\/)/.test(favicon) && !broken) {
    return <img src={favicon} alt="" className="h-[14px] w-[14px] flex-shrink-0 rounded-[3px]" onError={() => setBroken(true)} />;
  }
  return <Globe className="h-[13px] w-[13px] flex-shrink-0 text-[var(--text-muted)]" aria-hidden="true" />;
}

function ErrorView({
  message,
  url,
  onRetry,
  onOpenExternal,
}: {
  message: string;
  url: string;
  onRetry: () => void;
  onOpenExternal: (() => void) | null;
}) {
  const crashed = /stopped unexpectedly/i.test(message);
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6" role="alert">
      <div className="flex w-full max-w-[340px] flex-col items-center text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">
          {crashed ? 'This page stopped working' : "This page couldn't be opened"}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">{message}</p>
        {url ? (
          <p className="mt-2 max-w-full truncate font-mono text-[11px] text-[var(--text-muted)]" title={url}>
            {url}
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--text-primary)] px-3 text-[12px] font-medium text-[var(--bg-primary)] hover:opacity-90"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Try again
          </button>
          {onOpenExternal ? (
            <button
              type="button"
              onClick={onOpenExternal}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              Open in default browser
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? parsed.pathname.split('/').pop() || url : parsed.host;
  } catch {
    return url;
  }
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
