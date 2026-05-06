import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Toaster, toast } from 'sonner';
import {
  Check,
  CloudUpload,
  Copy,
  FileDiff,
  Files,
  FolderOpen,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  Sparkles,
  SquareTerminal,
  ChevronDown,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { useAppStore } from './store/useAppStore';
import { useIPC, sendEvent } from './hooks/useIPC';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Sidebar, SidebarHeaderTrigger } from './components/Sidebar';
import { PromptLibraryView } from './components/prompts/PromptLibraryView';
import { NewSessionView } from './components/NewSessionView';
import { PromptInput } from './components/PromptInput';
import { InSessionSearch } from './components/search/InSessionSearch';
import { Settings } from './components/settings/Settings';
import { SkillMarketSettingsContent } from './components/settings/SkillMarketSettings';
import { ProjectTreePanel } from './components/ProjectTreePanel';
import { BrowserPanel } from './components/browser/BrowserPanel';
import { TerminalDrawer } from './components/TerminalDrawer';
import { WorkspaceHost } from './components/WorkspaceHost';
import { AgentSetupDialog } from './components/AgentSetupDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useCodexModelConfig } from './hooks/useCodexModelConfig';
import { applyThemePreferences } from './theme/themes';
import { extractLatestSuccessfulHtmlArtifactFromLatestTurn } from './utils/artifacts';
import { openHtmlFileInBrowserTab } from './utils/html-preview';
import { StructuredResponse } from './components/StructuredResponse';
import {
  getMessageContentBlocks,
  normalizeToolResultBlock,
  normalizeToolUseBlock,
} from './utils/message-content';
import { aggregateMessages } from './utils/aggregated-messages';
import { resolveCodexModel } from './utils/codex-model';
import {
  deriveTurnPhase,
  hasRunningToolInMessages,
} from './utils/turn-utils';
import { AssistantWorkstream } from './components/AssistantWorkstream';
import { createStreamingWorkstreamModel } from './utils/workstream';
import type {
  ToolStatus,
  SessionStatus,
  StreamMessage,
  ContentBlock,
} from './types';

const COMMIT_GENERATION_MIN_VISIBLE_MS = 450;

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Tool result block type
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

export function App() {
  const electronAvailable =
    typeof window !== 'undefined' &&
    typeof window.electron !== 'undefined' &&
    typeof window.electron.onServerEvent === 'function';

  // Initialize IPC communication
  useIPC();

  // Initialize global keyboard shortcuts
  useKeyboardShortcuts();
  const codexModelConfig = useCodexModelConfig();

  const {
    connected,
    sessions,
    agentProfiles,
    agentSetupOpen,
    agentSetupDismissedAt,
    agentSetupCompletedAt,
    setAgentSetupOpen,
    activeSessionId,
    historyNavigationTarget,
    loadOlderSessionHistory,
    activeWorkspace,
    chatLayoutMode,
    savedSplitVisible,
    activePaneId,
    chatPanes,
    chatSplitRatio,
    showNewSession,
    newSessionKey,
    sidebarCollapsed,
    projectCwd,
    showSettings,
    projectTreeCollapsed,
    projectPanelView,
    terminalDrawerOpen,
    terminalDrawerHeight,
    browserPanelOpen,
    browserPanelWidth,
    rightPanelFullscreen,
    sessionsLoaded,
    setProjectTreeCollapsed,
    setProjectPanelView,
    setTerminalDrawerOpen,
    setTerminalDrawerHeight,
    setBrowserPanelOpen,
    setBrowserPanelWidth,
    setRightPanelFullscreen,
    closeSplitChat,
    globalError,
    clearGlobalError,
    theme,
    themeState,
    uiFontFamily,
    chatCodeFontFamily,
    setHistoryNavigationTarget,
  } = useAppStore();

  // Track history requests (prevent duplicates)
  const historyRequested = useRef(new Set<string>());
  const sessionStatusSnapshotRef = useRef(new Map<string, SessionStatus>());
  const pendingAutoPreviewSessionsRef = useRef(new Set<string>());
  const autoPreviewedArtifactsRef = useRef(new Set<string>());
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const agentProfileCount = Object.keys(agentProfiles).length;

  useEffect(() => {
    if (
      !electronAvailable ||
      !sessionsLoaded ||
      agentProfileCount > 0 ||
      agentSetupOpen ||
      agentSetupDismissedAt ||
      agentSetupCompletedAt
    ) {
      return;
    }

    setAgentSetupOpen(true);
  }, [
    agentProfileCount,
    agentSetupCompletedAt,
    agentSetupDismissedAt,
    agentSetupOpen,
    electronAvailable,
    sessionsLoaded,
    setAgentSetupOpen,
  ]);

  if (!electronAvailable) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-primary)] p-8">
        <div className="max-w-md text-center">
          <div className="text-lg font-semibold text-[var(--text-primary)]">Electron bridge unavailable</div>
          <div className="mt-2 text-sm text-[var(--text-secondary)]">
            The renderer started without the preload bridge. Restart the app from Electron instead of opening the Vite URL directly.
          </div>
        </div>
      </div>
    );
  }
  const [gitHeaderState, setGitHeaderState] = useState({
    hasRepo: false,
    branch: null as string | null,
    upstream: null as string | null,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    hasOriginRemote: false,
    isGitHubRemote: false,
    isDefaultBranch: false,
    totalChanges: 0,
    insertions: 0,
    deletions: 0,
    pr: null as
      | { number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string }
      | null,
  });
  const [highlightedHistoryAnchor, setHighlightedHistoryAnchor] = useState<string | null>(null);
  const historyHighlightTimerRef = useRef<number | null>(null);

  const { partialMessage, partialThinking, isStreaming: showPartialMessage } = useMemo(() => {
    if (!activeSession) {
      return { partialMessage: '', partialThinking: '', isStreaming: false };
    }

    return {
      partialMessage: activeSession.streaming.text,
      partialThinking: activeSession.streaming.thinking,
      isStreaming: activeSession.streaming.isStreaming,
    };
  }, [
    activeSession?.streaming.text,
    activeSession?.streaming.thinking,
    activeSession?.streaming.isStreaming,
  ]);

  // Messages list ref (for scrolling)
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Tool status and results maps
  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!activeSession) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of activeSession.messages) {
      if (msg.type !== 'assistant' && msg.type !== 'user') continue;
      for (const block of getMessageContentBlocks(msg)) {
        const normalizedUse = normalizeToolUseBlock(block);
        if (normalizedUse) {
          if (!statusMap.has(normalizedUse.id)) {
            statusMap.set(normalizedUse.id, 'pending');
          }
          continue;
        }
        const normalizedResult = normalizeToolResultBlock(block);
        if (normalizedResult) {
          statusMap.set(
            normalizedResult.tool_use_id,
            normalizedResult.is_error ? 'error' : 'success'
          );
          resultsMap.set(normalizedResult.tool_use_id, {
            type: 'tool_result',
            tool_use_id: normalizedResult.tool_use_id,
            content: normalizedResult.content,
            is_error: normalizedResult.is_error,
          });
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [activeSession?.messages]);

  // Compute current turn phase
  const turnPhase = useMemo(() => {
    if (!activeSession) return 'complete' as const;

    const isRunning = activeSession.status === 'running';
    const hasRunningTool = hasRunningToolInMessages(activeSession.messages, toolStatusMap);
    const isStreaming = showPartialMessage;

    return deriveTurnPhase(activeSession.messages, isRunning, hasRunningTool, isStreaming);
  }, [activeSession?.messages, activeSession?.status, toolStatusMap, showPartialMessage]);
  const aggregatedMessages = useMemo(
    () => (activeSession ? aggregateMessages(activeSession.messages) : []),
    [activeSession?.messages]
  );
  const historyNavigationAnchor = useMemo(() => {
    if (!activeSessionId || !historyNavigationTarget || historyNavigationTarget.sessionId !== activeSessionId) {
      return null;
    }

    for (const item of aggregatedMessages) {
      if (
        item.type === 'message' &&
        item.message.createdAt === historyNavigationTarget.messageCreatedAt
      ) {
        return String(item.originalIndex);
      }

      if (
        item.type === 'tool_batch' &&
        item.messages.some((message) => message.createdAt === historyNavigationTarget.messageCreatedAt)
      ) {
        return String(item.originalIndices[0]);
      }
    }

    return null;
  }, [activeSessionId, aggregatedMessages, historyNavigationTarget]);
  const historyNavigationPending =
    !!historyNavigationTarget &&
    historyNavigationTarget.sessionId === activeSessionId &&
    !historyNavigationAnchor;
  const streamingWorkstreamModel = useMemo(
    () =>
      createStreamingWorkstreamModel({
        partialThinking,
        phase: turnPhase,
        permissionRequests: activeSession?.permissionRequests || [],
      }),
    [activeSession?.permissionRequests, partialThinking, turnPhase]
  );

  useEffect(() => {
    if (connected) {
      sendEvent({ type: 'session.list' });
      sendEvent({ type: 'mcp.get-config' });
    }
  }, [connected]);

  const loadGitOverview = useCallback(async () => {
    const cwd = (activeSession?.cwd || projectCwd || '').trim();
    if (!cwd) {
      setGitHeaderState({
        hasRepo: false,
        branch: null,
        upstream: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        hasOriginRemote: false,
        isGitHubRemote: false,
        isDefaultBranch: false,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        pr: null,
      });
      return;
    }

    try {
      const overview = await window.electron.getGitOverview(cwd);
      if (!overview.ok) {
        setGitHeaderState({
          hasRepo: false,
          branch: null,
          upstream: null,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          hasOriginRemote: false,
          isGitHubRemote: false,
          isDefaultBranch: false,
          totalChanges: 0,
          insertions: 0,
          deletions: 0,
          pr: null,
        });
        return;
      }

      setGitHeaderState({
        hasRepo: overview.hasRepo,
        branch: overview.branch,
        upstream: overview.upstream,
        hasUpstream: overview.hasUpstream,
        aheadCount: overview.aheadCount,
        behindCount: overview.behindCount,
        hasOriginRemote: overview.hasOriginRemote,
        isGitHubRemote: overview.isGitHubRemote,
        isDefaultBranch: overview.isDefaultBranch,
        totalChanges: overview.totalChanges,
        insertions: overview.insertions,
        deletions: overview.deletions,
        pr: overview.pr,
      });
    } catch {
      setGitHeaderState({
        hasRepo: false,
        branch: null,
        upstream: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        hasOriginRemote: false,
        isGitHubRemote: false,
        isDefaultBranch: false,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        pr: null,
      });
    }
  }, [activeSession?.cwd, projectCwd]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await loadGitOverview();
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 60_000);

    const handleFocus = () => {
      void run();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [loadGitOverview, activeSession?.messages.length, activeSession?.status]);

  useEffect(() => {
    void window.electron.saveUiResumeState({
      activeSessionId,
      showNewSession,
      projectCwd,
      projectTreeCollapsed,
      projectPanelView,
      chatLayoutMode,
      savedSplitVisible,
      activePaneId,
      chatPanes,
      chatSplitRatio,
    });
  }, [
    activePaneId,
    activeSessionId,
    chatLayoutMode,
    savedSplitVisible,
    chatPanes,
    chatSplitRatio,
    projectCwd,
    projectPanelView,
    projectTreeCollapsed,
    showNewSession,
  ]);

  useEffect(() => {
    const nextStatuses = new Map<string, SessionStatus>();

    for (const session of Object.values(sessions)) {
      nextStatuses.set(session.id, session.status);

      const previousStatus = sessionStatusSnapshotRef.current.get(session.id);
      if (previousStatus === 'running' && session.status === 'completed' && session.cwd) {
        pendingAutoPreviewSessionsRef.current.add(session.id);
      }

      if (session.status !== 'completed' || !session.cwd) {
        pendingAutoPreviewSessionsRef.current.delete(session.id);
        continue;
      }

      if (!pendingAutoPreviewSessionsRef.current.has(session.id)) {
        continue;
      }

      const artifact = extractLatestSuccessfulHtmlArtifactFromLatestTurn(session.messages);
      if (!artifact) {
        continue;
      }

      const previewKey = `${session.id}:${artifact.toolUseId}`;
      if (autoPreviewedArtifactsRef.current.has(previewKey)) {
        pendingAutoPreviewSessionsRef.current.delete(session.id);
        continue;
      }
      autoPreviewedArtifactsRef.current.add(previewKey);

      const sessionId = session.id;
      void openHtmlFileInBrowserTab({
        cwd: session.cwd,
        filePath: artifact.filePath,
        sessionId,
      })
        .then(() => {
          if (sessionId === activeSessionId) {
            setBrowserPanelOpen(true);
            setProjectTreeCollapsed(true);
          }
          pendingAutoPreviewSessionsRef.current.delete(sessionId);
        })
        .catch((error) => {
          autoPreviewedArtifactsRef.current.delete(previewKey);
          toast.error(`Failed to open in browser panel: ${error}`);
        });
    }

    sessionStatusSnapshotRef.current = nextStatuses;
  }, [sessions, activeSessionId, setBrowserPanelOpen, setProjectTreeCollapsed]);

  useEffect(() => {
    applyThemePreferences({
      themeMode: theme,
      themeState,
      uiFontFamily,
      chatCodeFontFamily,
    });
  }, [chatCodeFontFamily, theme, themeState, uiFontFamily]);

  // Request history when switching sessions
  useEffect(() => {
    if (!activeSessionId) return;

    if (!activeSession) return;

    // If session not hydrated and not yet requested, fetch history
    if (!activeSession.hydrated && !historyRequested.current.has(activeSessionId)) {
      historyRequested.current.add(activeSessionId);
      sendEvent({
        type: 'session.history',
        payload: { sessionId: activeSessionId },
      });
    }
  }, [activeSessionId, activeSession]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: showPartialMessage ? 'auto' : 'smooth' });
  }, [
    activeSessionId,
    activeSession?.messages.length,
    activeSession?.streaming.isStreaming,
    partialMessage,
    partialThinking,
    showPartialMessage,
  ]);

  // Reset scroll tracking on session change
  const prevMessageCountRef = useRef<number>(0);
  const scrollHeightBeforeLoadRef = useRef<number>(0);
  useEffect(() => {
    prevMessageCountRef.current = 0;
    scrollHeightBeforeLoadRef.current = 0;
  }, [activeSessionId]);

  // Preserve scroll position after prepending older messages
  useEffect(() => {
    const container = scrollContainerRef.current;
    const count = activeSession?.messages.length ?? 0;
    const prevCount = prevMessageCountRef.current;
    if (container && count > prevCount && prevCount > 0 && scrollHeightBeforeLoadRef.current > 0) {
      const delta = container.scrollHeight - scrollHeightBeforeLoadRef.current;
      if (delta > 0) {
        container.scrollTop += delta;
      }
    }
    prevMessageCountRef.current = count;
    scrollHeightBeforeLoadRef.current = 0;
  }, [activeSession?.messages.length]);

  // Infinite scroll: load older messages when scrolled near top
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !activeSessionId || !activeSession?.hasMoreHistory || activeSession?.loadingMoreHistory) return;
    if (container.scrollTop < 200) {
      scrollHeightBeforeLoadRef.current = container.scrollHeight;
      loadOlderSessionHistory(activeSessionId);
    }
  }, [activeSessionId, activeSession?.hasMoreHistory, activeSession?.loadingMoreHistory, loadOlderSessionHistory]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!historyNavigationTarget || !activeSessionId || historyNavigationTarget.sessionId !== activeSessionId) {
      return;
    }

    if (!activeSession?.hydrated) {
      return;
    }

    if (!historyNavigationAnchor) {
      if (activeSession.hasMoreHistory && !activeSession.loadingMoreHistory) {
        if (scrollContainerRef.current) {
          scrollHeightBeforeLoadRef.current = scrollContainerRef.current.scrollHeight;
        }
        loadOlderSessionHistory(activeSessionId);
        return;
      }

      if (!activeSession.hasMoreHistory && !activeSession.loadingMoreHistory) {
        toast.error('Could not locate the selected message in session history.');
        setHistoryNavigationTarget(null);
      }
      return;
    }

    const selector = `[data-message-index="${historyNavigationAnchor}"]`;
    const messageEl = document.querySelector(selector);
    if (!messageEl) {
      return;
    }

    messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedHistoryAnchor(historyNavigationAnchor);
    setHistoryNavigationTarget(null);

    if (historyHighlightTimerRef.current !== null) {
      window.clearTimeout(historyHighlightTimerRef.current);
    }

    historyHighlightTimerRef.current = window.setTimeout(() => {
      setHighlightedHistoryAnchor((current) => (current === historyNavigationAnchor ? null : current));
      historyHighlightTimerRef.current = null;
    }, 2400);
  }, [
    activeSession?.hydrated,
    activeSession?.hasMoreHistory,
    activeSession?.loadingMoreHistory,
    activeSessionId,
    historyNavigationAnchor,
    historyNavigationTarget,
    loadOlderSessionHistory,
    setHistoryNavigationTarget,
  ]);

  useEffect(() => {
    return () => {
      if (historyHighlightTimerRef.current !== null) {
        window.clearTimeout(historyHighlightTimerRef.current);
      }
    };
  }, []);

  // Global error notification
  useEffect(() => {
    if (globalError) {
      toast.error(globalError, {
        duration: 5000,
        onDismiss: clearGlobalError,
        onAutoClose: clearGlobalError,
      });
    }
  }, [globalError, clearGlobalError]);

  const lastUserPromptIndex = useMemo(() => {
    if (!activeSession) return -1;
    for (let i = activeSession.messages.length - 1; i >= 0; i--) {
      if (activeSession.messages[i]?.type === 'user_prompt') {
        return i;
      }
    }
    return -1;
  }, [activeSession?.messages]);

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg-primary)]">
      {/* Sidebar */}
      {!showSettings && <Sidebar />}

      {/* Main content area — hidden (display:none) when a right panel is fullscreened.
          Uses display:contents when visible so its children still participate as flex items
          of the outer app row (preserves existing layout). */}
      <div className={rightPanelFullscreen ? 'hidden' : 'contents'}>
      {!showSettings && activeWorkspace === 'chat' && !sessionsLoaded ? (
        <div className="flex-1 min-w-0 bg-[var(--bg-primary)]" />
      ) : showSettings ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
          <div className="flex-1 min-h-0">
            <Settings />
          </div>
        </div>
      ) : activeWorkspace === 'skills' ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
          <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0 bg-[var(--bg-primary)]`}>
            <div className="flex h-full items-center px-3">
              {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
            </div>
          </div>
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1360px] px-8 py-8">
              <SkillMarketSettingsContent />
            </div>
          </main>
        </div>
      ) : activeWorkspace === 'prompts' ? (
        <PromptLibraryView />
      ) : chatLayoutMode === 'split' || (activeSession && !showNewSession) ? (
        <div
          className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden transition-[padding] duration-200"
          style={{ paddingRight: 'var(--project-preview-space, 0px)' }}
        >
          {/* Top drag region */}
          <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0 bg-[var(--bg-primary)]`}>
            <div className="flex h-full items-center justify-between px-3">
              <div className="flex items-center gap-0.5">
                {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
              </div>
              <div className="flex items-center justify-end">
                <InlineProjectPanelHeaderActions
                  collapsed={projectTreeCollapsed}
                  activeTab={projectPanelView}
                  changeStats={{
                    insertions: gitHeaderState.insertions,
                    deletions: gitHeaderState.deletions,
                  }}
                  onToggle={(view) => {
                    if (!projectTreeCollapsed && !browserPanelOpen && projectPanelView === view) {
                      setProjectTreeCollapsed(true);
                      return;
                    }
                    setProjectPanelView(view);
                    setProjectTreeCollapsed(false);
                    if (browserPanelOpen) setBrowserPanelOpen(false);
                  }}
                />
                <button
                  type="button"
                  onClick={() => setTerminalDrawerOpen(!terminalDrawerOpen)}
                  className={`no-drag inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition-colors ${
                    terminalDrawerOpen
                      ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  title="Terminal"
                  aria-label="Toggle terminal drawer"
                >
                  <SquareTerminal className="h-[13px] w-[13px] shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !browserPanelOpen;
                    setBrowserPanelOpen(next);
                    if (next) setProjectTreeCollapsed(true);
                  }}
                  className={`no-drag inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition-colors ${
                    browserPanelOpen
                      ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  title="Browser"
                  aria-label="Toggle browser panel"
                >
                  <Globe className="h-[13px] w-[13px] shrink-0" />
                </button>
                <GitHeaderActions
                  cwd={activeSession?.cwd || projectCwd || null}
                  state={gitHeaderState}
                  onRefreshGitState={loadGitOverview}
                />
              </div>
            </div>
          </div>

          <WorkspaceHost codexModelConfig={codexModelConfig} />

          <TerminalDrawer
            open={terminalDrawerOpen}
            height={terminalDrawerHeight}
            onHeightChange={setTerminalDrawerHeight}
            onClose={() => setTerminalDrawerOpen(false)}
            sessionId={activeSessionId}
            cwd={activeSession?.cwd || projectCwd || null}
          />
        </div>
      ) : (
        <NewSessionView key={newSessionKey} />
      )}
      </div>

      {/* Right project tree panel */}
      {!showSettings && activeWorkspace === 'chat' && (
        <ProjectTreePanel
          collapsed={projectTreeCollapsed || browserPanelOpen}
          activeTab={projectPanelView}
          onClose={() => setProjectTreeCollapsed(true)}
          isFullscreen={rightPanelFullscreen === 'files'}
          onToggleFullscreen={() =>
            setRightPanelFullscreen(rightPanelFullscreen === 'files' ? null : 'files')
          }
        />
      )}

      {/* Right browser panel (per-session) */}
      {!showSettings && activeWorkspace === 'chat' && activeSessionId && (
        <BrowserPanel
          sessionId={activeSessionId}
          collapsed={!browserPanelOpen}
          width={browserPanelWidth}
          onClose={() => setBrowserPanelOpen(false)}
          onWidthChange={setBrowserPanelWidth}
          isFullscreen={rightPanelFullscreen === 'browser'}
          onToggleFullscreen={() =>
            setRightPanelFullscreen(rightPanelFullscreen === 'browser' ? null : 'browser')
          }
        />
      )}

      <AgentSetupDialog />

      {/* Toast notifications */}
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          },
        }}
      />

    </div>
  );
}

function InlineProjectPanelHeaderActions({
  onToggle,
  collapsed,
  activeTab,
  changeStats,
}: {
  onToggle: (view: 'files' | 'changes') => void;
  collapsed: boolean;
  activeTab: 'files' | 'changes';
  changeStats: { insertions: number; deletions: number };
}) {
  const items = [
    {
      id: 'files' as const,
      label: 'Files',
      icon: Files,
    },
    {
      id: 'changes' as const,
      label: 'Changes',
      icon: FileDiff,
    },
  ];

  return (
    <div className="no-drag flex flex-shrink-0 items-center gap-1">
      {items
        .filter(
          (item) =>
            item.id !== 'changes' ||
            changeStats.insertions > 0 ||
            changeStats.deletions > 0
        )
        .map((item) => {
        const Icon = item.icon;
        const active = !collapsed && activeTab === item.id;

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            title={item.label}
            aria-label={`Open ${item.label} panel`}
            className={`inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-medium transition-colors ${
              active
                ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            {item.id === 'changes' ? (
              <span className="inline-flex items-center gap-1">
                {changeStats.insertions > 0 ? (
                  <span className="font-mono text-[10px] font-medium tabular-nums text-emerald-600">
                    +{changeStats.insertions}
                  </span>
                ) : null}
                {changeStats.deletions > 0 ? (
                  <span className="font-mono text-[10px] font-medium tabular-nums text-[var(--error)]">
                    -{changeStats.deletions}
                  </span>
                ) : null}
              </span>
            ) : (
              <Icon className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function GitHeaderActions({
  cwd,
  state,
  onRefreshGitState,
}: {
  cwd: string | null;
      state: {
        hasRepo: boolean;
        branch: string | null;
        upstream: string | null;
        hasUpstream: boolean;
        aheadCount: number;
        behindCount: number;
        hasOriginRemote: boolean;
        isGitHubRemote: boolean;
        isDefaultBranch: boolean;
        totalChanges: number;
        insertions: number;
        deletions: number;
        pr: { number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string } | null;
      };
  onRefreshGitState: () => Promise<void>;
}) {
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitMode, setCommitMode] = useState<'commit' | 'commit_push'>('commit');
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitGenerating, setCommitGenerating] = useState(false);
  const [commitGenerationError, setCommitGenerationError] = useState<string | null>(null);
  const [commitGenerationNotice, setCommitGenerationNotice] = useState<string | null>(null);
  const [commitSuggestionSignature, setCommitSuggestionSignature] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  const commitChangeSignature = useMemo(
    () => `${cwd || ''}:${state.branch || 'HEAD'}:${state.totalChanges}:${state.insertions}:${state.deletions}`,
    [cwd, state.branch, state.totalChanges, state.insertions, state.deletions]
  );

  const createFallbackCommitMessage = useCallback(async () => {
    if (!cwd) return null;

    const changes = await window.electron.getGitChanges(cwd);
    if (!changes.ok || changes.entries.length === 0) return null;

    const files = changes.entries.map((entry) => entry.filePath);
    const allDocs = files.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath));
    const allTests = files.every((filePath) => /\.(test|spec)\.[jt]sx?$/i.test(filePath) || filePath.includes('__tests__'));
    const allStyles = files.every((filePath) => /\.(css|scss|sass|less)$/i.test(filePath));
    const hasAdded = changes.entries.some((entry) => entry.status === '?' || entry.status === 'A');
    const type = allDocs ? 'docs' : allTests ? 'test' : allStyles ? 'style' : hasAdded ? 'feat' : 'chore';
    const target = files.some((filePath) => filePath.startsWith('src/ui/'))
      ? 'UI'
      : files.some((filePath) => filePath.startsWith('src/electron/'))
        ? 'electron'
        : files.length === 1
          ? files[0]
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '')
              .replace(/[-_]+/g, ' ')
              .toLowerCase()
              .trim() || 'project files'
          : 'project files';
    const verbByType: Record<string, string> = {
      docs: 'update',
      test: 'update',
      style: 'adjust',
      feat: 'add',
      chore: 'update',
    };

    return `${type}: ${verbByType[type] || 'update'} ${target}`;
  }, [cwd]);

  const handleGenerateCommitMessage = useCallback(async (
    signature = commitChangeSignature,
    options: { showUnchangedNotice?: boolean } = {}
  ) => {
    if (!cwd) return;

    const startedAt = Date.now();
    const previousMessage = commitMessage.trim();
    setCommitGenerating(true);
    setCommitGenerationError(null);
    setCommitGenerationNotice(null);
    setCommitSuggestionSignature(signature);
    try {
      const generateCommitMessage = window.electron.gitGenerateCommitMessage;
      if (typeof generateCommitMessage === 'function') {
        const result = await generateCommitMessage(cwd);
        if (result.ok && result.message) {
          setCommitMessage(result.message);
          if (options.showUnchangedNotice && result.message.trim() === previousMessage) {
            setCommitGenerationNotice('Commit message is already up to date for these changes.');
          }
          return;
        }

        throw new Error(result.message || 'Failed to generate commit message.');
      }

      throw new Error('Commit message generator is not available. Restart Aegis to load the latest preload.');
    } catch (error) {
      let fallbackMessage: string | null = null;
      try {
        fallbackMessage = await createFallbackCommitMessage();
      } catch {
        fallbackMessage = null;
      }

      if (fallbackMessage) {
        setCommitMessage(fallbackMessage);
        setCommitGenerationError('Used a basic local suggestion. Restart Aegis if the Generate button still cannot use the full generator.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to generate commit message.';
      setCommitGenerationError(message);
      toast.error(message);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < COMMIT_GENERATION_MIN_VISIBLE_MS) {
        await wait(COMMIT_GENERATION_MIN_VISIBLE_MS - elapsed);
      }
      setCommitGenerating(false);
    }
  }, [commitChangeSignature, commitMessage, createFallbackCommitMessage, cwd]);

  const openCommitDialog = useCallback((mode: 'commit' | 'commit_push') => {
    setCommitMode(mode);
    setCommitMessage('');
    setCommitGenerationError(null);
    setCommitGenerationNotice(null);
    setCommitSuggestionSignature(null);
    setCommitDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!commitDialogOpen || !cwd || state.totalChanges === 0 || commitMessage.trim()) return;
    if (commitSuggestionSignature === commitChangeSignature) return;
    void handleGenerateCommitMessage(commitChangeSignature);
  }, [
    commitChangeSignature,
    commitDialogOpen,
    commitMessage,
    commitSuggestionSignature,
    cwd,
    handleGenerateCommitMessage,
    state.totalChanges,
  ]);

  if (!state.hasRepo || !cwd) {
    return null;
  }

  const hasPendingChanges = state.totalChanges > 0;
  const canPush = !!state.branch && state.hasOriginRemote;
  const canCreatePr = !!state.branch && state.hasOriginRemote && state.isGitHubRemote && !hasPendingChanges;

  const quickAction = state.pr?.state === 'open'
    ? { kind: 'open-pr' as const, label: 'View PR', icon: ExternalLink }
    : hasPendingChanges
      ? { kind: 'commit' as const, label: 'Commit', icon: GitCommit }
      : state.behindCount > 0
        ? { kind: 'sync' as const, label: 'Sync', icon: RefreshCw }
        : state.aheadCount > 0 && canCreatePr
          ? { kind: 'create-pr' as const, label: 'Create PR', icon: ExternalLink }
          : { kind: 'push' as const, label: 'Push', icon: Upload };

  const handlePush = async () => {
    setPushLoading(true);
    try {
      const result = await window.electron.gitPush(cwd);
      if (!result.ok) {
        toast.error(result.message || 'Push failed.');
        return;
      }
      toast.success('Push completed.');
      await onRefreshGitState();
    } finally {
      setPushLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      const result = await window.electron.gitSync(cwd);
      if (!result.ok) {
        toast.error(result.message || 'Sync failed.');
        return;
      }
      toast.success('Remote synced.');
      await onRefreshGitState();
    } finally {
      setSyncLoading(false);
    }
  };

  const handleOpenPr = async () => {
    if (!state.pr?.url) return;
    const result = await window.electron.openExternalUrl(state.pr.url);
    if (!result.ok) {
      toast.error(result.message || 'Failed to open pull request.');
    }
  };

  const handleCreatePr = async () => {
    setPrLoading(true);
    try {
      const result = await window.electron.gitCreatePr(cwd);
      if (!result.ok || !result.url) {
        toast.error(result.message || 'Failed to create pull request.');
        return;
      }
      toast.success('Pull request created.');
      await window.electron.openExternalUrl(result.url);
      await onRefreshGitState();
    } finally {
      setPrLoading(false);
    }
  };

  const handleCommit = async () => {
    const message = commitMessage.trim();
    if (!message) {
      return;
    }

    setCommitLoading(true);
    try {
      const changes = await window.electron.getGitChanges(cwd);
      if (!changes.ok) {
        toast.error('Failed to read git status.');
        return;
      }

      for (const entry of changes.entries.filter((item) => !item.staged)) {
        const stageResult = await window.electron.gitStagePath(cwd, entry.filePath);
        if (!stageResult.ok) {
          toast.error(stageResult.message || `Failed to stage ${entry.filePath}.`);
          return;
        }
      }

      const result = await window.electron.gitCommit(cwd, message);
      if (!result.ok) {
        toast.error(result.message || 'Commit failed.');
        return;
      }

      if (commitMode === 'commit_push') {
        const pushResult = await window.electron.gitPush(cwd);
        if (!pushResult.ok) {
          toast.error(pushResult.message || 'Push failed.');
          return;
        }
      }

      toast.success(commitMode === 'commit_push' ? 'Commit and push completed.' : 'Commit created.');
      setCommitDialogOpen(false);
      setCommitMessage('');
      setCommitMode('commit');
      await onRefreshGitState();
    } finally {
      setCommitLoading(false);
    }
  };

  return (
    <div className="no-drag flex flex-shrink-0 items-center gap-2">
      <DropdownMenu.Root>
        <div className="inline-flex items-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
          <button
            type="button"
            onClick={() => openCommitDialog('commit')}
            disabled={state.totalChanges === 0 || commitLoading || pushLoading || prLoading || syncLoading}
            className="inline-flex h-6 items-center gap-1.5 px-2 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            <GitCommit className="h-3.5 w-3.5" />
            <span>Commit</span>
          </button>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="inline-flex h-6 items-center justify-center border-l border-[var(--border)]/60 px-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-tertiary)] data-[state=open]:text-[var(--text-primary)]"
              aria-label="Git actions"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenu.Trigger>
        </div>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="popover-surface z-50 min-w-[180px] p-1.5"
          >
            <DropdownMenu.Item
              onSelect={() => openCommitDialog('commit')}
              disabled={state.totalChanges === 0 || commitLoading || pushLoading || prLoading || syncLoading}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <GitCommit className="h-3.5 w-3.5" />
              <span>Commit</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => openCommitDialog('commit_push')}
              disabled={state.totalChanges === 0 || commitLoading || pushLoading || prLoading || syncLoading}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <CloudUpload className="h-3.5 w-3.5" />
              <span>Commit & Push</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => void handleCreatePr()}
              disabled={!canCreatePr || prLoading || commitLoading || pushLoading || syncLoading}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <GitHubMark className="h-3.5 w-3.5" />
              <span>{prLoading ? 'Creating…' : 'Create PR'}</span>
            </DropdownMenu.Item>
            {state.pr?.url ? (
              <DropdownMenu.Item
                onSelect={() => void handleOpenPr()}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <GitHubMark className="h-3.5 w-3.5" />
                <span>View PR</span>
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item
              onSelect={() => void handleSync()}
              disabled={syncLoading || commitLoading || pushLoading || prLoading}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{syncLoading ? 'Syncing…' : 'Sync'}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog.Root open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/18 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[100] w-[min(392px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <Dialog.Title className="text-[14px] font-semibold text-[var(--text-primary)]">
                Commit changes
              </Dialog.Title>
              <button
                type="button"
                onClick={() => setCommitDialogOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-3 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <div className="text-[var(--text-secondary)]">Branch</div>
                <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
                  <GitBranch className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  <span>{state.branch || 'HEAD'}</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 text-[12px]">
                <div className="text-[var(--text-secondary)]">Changes</div>
                <div className="flex items-center gap-3">
                  <span className="text-[var(--text-muted)]">{state.totalChanges} files</span>
                  <span className="font-medium text-emerald-600">+{state.insertions}</span>
                  <span className="font-medium text-[var(--error)]">-{state.deletions}</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] font-medium text-[var(--text-secondary)]">Message</div>
                <button
                  type="button"
                  onClick={() => void handleGenerateCommitMessage(commitChangeSignature, { showUnchangedNotice: true })}
                  disabled={commitGenerating || commitLoading}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {commitGenerating ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  <span>{commitGenerating ? 'Generating…' : 'Generate'}</span>
                </button>
              </div>

              <div className={`overflow-hidden rounded-[var(--radius-xl)] border bg-[var(--bg-secondary)]/92 ${commitGenerating ? 'border-[var(--accent)]/45' : 'border-[var(--border)]'}`}>
                <textarea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={commitGenerating ? 'Generating commit message...' : 'Commit message...'}
                  rows={4}
                  className="w-full resize-none border-0 bg-transparent px-3 py-3 text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                />
              </div>
              {commitGenerating || commitGenerationError || commitGenerationNotice ? (
                <div className={`flex items-center gap-2 text-[11px] leading-4 ${commitGenerationError ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>
                  {commitGenerating ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                  <span>
                    {commitGenerating
                      ? 'Generating commit message...'
                      : commitGenerationError || commitGenerationNotice}
                  </span>
                </div>
              ) : null}

              <div className="space-y-1.5 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)]/92 p-3">
                <label className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                  <input
                    type="radio"
                    checked={commitMode === 'commit'}
                    onChange={() => setCommitMode('commit')}
                  />
                  <span>Commit</span>
                </label>
                <label className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                  <input
                    type="radio"
                    checked={commitMode === 'commit_push'}
                    onChange={() => setCommitMode('commit_push')}
                  />
                  <span>Commit & Push</span>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-[var(--border)] px-4 py-3">
              <button
                type="button"
                onClick={() => setCommitDialogOpen(false)}
                className="inline-flex h-9 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCommit()}
                disabled={commitLoading || commitGenerating || !commitMessage.trim()}
                className="inline-flex h-9 min-w-[118px] items-center justify-center rounded-[var(--radius-lg)] bg-[var(--accent)] px-3.5 text-[13px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {commitLoading ? 'Working…' : commitMode === 'commit_push' ? 'Commit & Push' : 'Commit'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.83-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8 8 0 0 0 8 0Z"
      />
    </svg>
  );
}

function getPathLeaf(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || path;
}

// Copy button component
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy failed
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
      title="Copy full path"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
