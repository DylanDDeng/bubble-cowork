import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { sendEvent } from '../hooks/useIPC';
import { useAppStore } from '../store/useAppStore';
import { createStreamingWorkstreamModel } from '../utils/workstream';
import { deriveTurnPhase, hasRunningToolInMessages } from '../utils/turn-utils';
import {
  getMessageContentBlocks,
  normalizeToolResultBlock,
  normalizeToolUseBlock,
} from '../utils/message-content';
import { deriveTranscriptTimelineItems } from '../utils/transcript-timeline';
import { resolveCodexModel } from '../utils/codex-model';
import { MessageCard } from './MessageCard';
import { ToolExecutionBatch, WorkstreamDisclosure } from './ToolExecutionBatch';
import { StructuredResponse } from './StructuredResponse';
import { WorkingFooter } from './AssistantWorkstream';
import { PromptInput } from './PromptInput';
import { InSessionSearch } from './search/InSessionSearch';
import { CodexApprovalPermissionDialog } from './CodexApprovalPermissionDialog';
import { DecisionPanel } from './DecisionPanel';
import { ExternalFilePermissionDialog } from './ExternalFilePermissionDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { TurnChangesCard } from './TurnChangesCard';
import { TurnDiffContext, type TurnDiffContextValue } from './TurnDiffContext';
import { TurnDiffDrawer } from './TurnDiffDrawer';
import {
  buildTurnChangeContext,
  type TurnChangeSummary,
} from '../utils/turn-change-records';
import type { ChangeRecord } from '../utils/change-records';
import type {
  AskUserQuestionInput,
  CodexApprovalPermissionInput,
  ContentBlock,
  ExternalFilePermissionInput,
  PermissionResult,
  StreamMessage,
  ToolStatus,
} from '../types';

type ToolResultBlock = ContentBlock & { type: 'tool_result' };

function isExternalFilePermissionInput(input: unknown): input is ExternalFilePermissionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind?: unknown }).kind === 'external-file-access'
  );
}

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'questions' in input &&
    Array.isArray((input as { questions?: unknown }).questions)
  );
}

function isCodexApprovalPermissionInput(input: unknown): input is CodexApprovalPermissionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind?: unknown }).kind === 'codex-approval'
  );
}

export function ChatPane({
  paneId,
  sessionId,
  isActive,
  onActivate,
  codexModelConfig,
  dropHint,
  onDropSession,
  onClose,
  headerActions,
}: {
  paneId: 'primary' | 'secondary';
  sessionId: string | null;
  isActive: boolean;
  onActivate: () => void;
  codexModelConfig: import('../types').CodexModelConfig;
  dropHint?: string | null;
  onDropSession?: (sessionId: string) => void;
  onClose?: () => void;
  headerActions?: ReactNode;
}) {
  const {
    sessions,
    historyNavigationTarget,
    loadOlderSessionHistory,
    setHistoryNavigationTarget,
    removePermissionRequest,
  } = useAppStore();
  const session = sessionId ? sessions[sessionId] : null;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const historyRequested = useRef(new Set<string>());
  const prevMessageCountRef = useRef<number>(0);
  const scrollHeightBeforeLoadRef = useRef<number>(0);
  const historyHighlightTimerRef = useRef<number | null>(null);
  const [highlightedHistoryAnchor, setHighlightedHistoryAnchor] = useState<string | null>(null);
  const [selectedDiffRecord, setSelectedDiffRecord] = useState<ChangeRecord | null>(null);

  const { partialMessage, partialThinking, isStreaming: showPartialMessage } = useMemo(() => {
    if (!session) {
      return { partialMessage: '', partialThinking: '', isStreaming: false };
    }

    return {
      partialMessage: session.streaming.text,
      partialThinking: session.streaming.thinking,
      isStreaming: session.streaming.isStreaming,
    };
  }, [session?.streaming.text, session?.streaming.thinking, session?.streaming.isStreaming]);

  const streamingAssistantText = useMemo(() => {
    if (!session) return '';
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message.type !== 'assistant' || message.streaming !== true) {
        continue;
      }
      return getMessageContentBlocks(message)
        .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
        .map((block) => block.text || '')
        .join('\n');
    }
    return '';
  }, [session?.messages]);

  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!session) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of session.messages) {
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
  }, [session?.messages]);

  const hasRunningTool = useMemo(
    () => (session ? hasRunningToolInMessages(session.messages, toolStatusMap) : false),
    [session?.messages, toolStatusMap]
  );

  const turnPhase = useMemo(() => {
    if (!session) return 'complete' as const;

    const isRunning = session.status === 'running';
    const isStreaming = showPartialMessage || streamingAssistantText.length > 0;

    return deriveTurnPhase(session.messages, isRunning, hasRunningTool, isStreaming);
  }, [session?.messages, session?.status, hasRunningTool, showPartialMessage, streamingAssistantText]);

  const lastUserPromptIndex = useMemo(() => {
    if (!session) return -1;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      if (session.messages[i]?.type === 'user_prompt') {
        return i;
      }
    }
    return -1;
  }, [session?.messages]);

  const timelineItems = useMemo(
    () =>
      session
        ? deriveTranscriptTimelineItems(session.messages, {
            activeTurnStartIndex: lastUserPromptIndex,
            sessionRunning: session.status === 'running',
          })
        : [],
    [lastUserPromptIndex, session?.messages, session?.status]
  );

  const { turns, changeRecordByToolUseId } = useMemo(
    () =>
      session
        ? buildTurnChangeContext(session.messages)
        : { turns: [] as TurnChangeSummary[], changeRecordByToolUseId: new Map<string, ChangeRecord>() },
    [session?.messages]
  );

  const turnCardByTimelineIndex = useMemo(() => {
    const map = new Map<number, TurnChangeSummary>();
    if (turns.length === 0 || timelineItems.length === 0) {
      return map;
    }
    for (const turn of turns) {
      if (turn.totalFiles === 0) continue;
      let lastIdx = -1;
      for (let i = 0; i < timelineItems.length; i += 1) {
        const item = timelineItems[i];
        const lastOrig =
          item.type === 'work'
            ? item.group.originalIndices[item.group.originalIndices.length - 1]
            : item.originalIndex;
        if (lastOrig <= turn.lastMessageIndex) {
          lastIdx = i;
        } else {
          break;
        }
      }
      if (lastIdx >= 0) {
        map.set(lastIdx, turn);
      }
    }
    return map;
  }, [turns, timelineItems]);

  const handleOpenDiff = useCallback((record: ChangeRecord) => {
    setSelectedDiffRecord(record);
  }, []);

  const handleCloseDiff = useCallback(() => {
    setSelectedDiffRecord(null);
  }, []);

  const turnDiffContextValue = useMemo<TurnDiffContextValue>(
    () => ({
      changeRecordByToolUseId,
      onOpenDiff: handleOpenDiff,
    }),
    [changeRecordByToolUseId, handleOpenDiff]
  );

  const historyNavigationAnchor = useMemo(() => {
    if (!sessionId || !historyNavigationTarget || historyNavigationTarget.sessionId !== sessionId) {
      return null;
    }

    for (const item of timelineItems) {
      if (item.type === 'message' && item.message.createdAt === historyNavigationTarget.messageCreatedAt) {
        return String(item.originalIndex);
      }

      if (
        item.type === 'work' &&
        item.group.messages.some((message) => message.createdAt === historyNavigationTarget.messageCreatedAt)
      ) {
        return String(item.group.originalIndices[0]);
      }
    }

    return null;
  }, [historyNavigationTarget, sessionId, timelineItems]);

  const historyNavigationPending =
    !!historyNavigationTarget &&
    historyNavigationTarget.sessionId === sessionId &&
    !historyNavigationAnchor;

  const streamingWorkstreamModel = useMemo(
    () =>
      createStreamingWorkstreamModel({
        partialThinking,
        phase: turnPhase,
        permissionRequests: session?.permissionRequests || [],
      }),
    [partialThinking, session?.permissionRequests, turnPhase]
  );

  useEffect(() => {
    if (!sessionId || !session) {
      return;
    }

    if (!session.hydrated && !historyRequested.current.has(sessionId)) {
      historyRequested.current.add(sessionId);
      sendEvent({
        type: 'session.history',
        payload: { sessionId },
      });
    }
  }, [session, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    messagesEndRef.current?.scrollIntoView({ behavior: showPartialMessage ? 'auto' : 'smooth' });
  }, [
    sessionId,
    session?.messages.length,
    session?.streaming.isStreaming,
    partialMessage,
    partialThinking,
    streamingAssistantText,
    showPartialMessage,
  ]);

  useEffect(() => {
    prevMessageCountRef.current = 0;
    scrollHeightBeforeLoadRef.current = 0;
    setHighlightedHistoryAnchor(null);
    setSelectedDiffRecord(null);
  }, [sessionId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const count = session?.messages.length ?? 0;
    const prevCount = prevMessageCountRef.current;
    if (container && count > prevCount && prevCount > 0 && scrollHeightBeforeLoadRef.current > 0) {
      const delta = container.scrollHeight - scrollHeightBeforeLoadRef.current;
      if (delta > 0) {
        container.scrollTop += delta;
      }
    }
    prevMessageCountRef.current = count;
    scrollHeightBeforeLoadRef.current = 0;
  }, [session?.messages.length]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !sessionId || !session?.hasMoreHistory || session?.loadingMoreHistory) return;
    if (container.scrollTop < 200) {
      scrollHeightBeforeLoadRef.current = container.scrollHeight;
      loadOlderSessionHistory(sessionId);
    }
  }, [loadOlderSessionHistory, session?.hasMoreHistory, session?.loadingMoreHistory, sessionId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!historyNavigationTarget || !sessionId || historyNavigationTarget.sessionId !== sessionId) {
      return;
    }

    if (!session?.hydrated) {
      return;
    }

    if (!historyNavigationAnchor) {
      if (session.hasMoreHistory && !session.loadingMoreHistory) {
        if (scrollContainerRef.current) {
          scrollHeightBeforeLoadRef.current = scrollContainerRef.current.scrollHeight;
        }
        loadOlderSessionHistory(sessionId);
        return;
      }

      if (!session.hasMoreHistory && !session.loadingMoreHistory) {
        toast.error('Could not locate the selected message in session history.');
        setHistoryNavigationTarget(null);
      }
      return;
    }

    const selector = `[data-message-index="${historyNavigationAnchor}"]`;
    const messageEl = scrollContainerRef.current?.querySelector(selector);
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
    historyNavigationAnchor,
    historyNavigationTarget,
    loadOlderSessionHistory,
    session?.hasMoreHistory,
    session?.hydrated,
    session?.loadingMoreHistory,
    sessionId,
    setHistoryNavigationTarget,
  ]);

  useEffect(() => {
    return () => {
      if (historyHighlightTimerRef.current !== null) {
        window.clearTimeout(historyHighlightTimerRef.current);
      }
    };
  }, []);

  const handlePermissionResult = (toolUseId: string, result: PermissionResult) => {
    if (!sessionId) return;

    sendEvent({
      type: 'permission.response',
      payload: {
        sessionId,
        toolUseId,
        result,
      },
    });

    removePermissionRequest(sessionId, toolUseId);
  };

  const activeExternalPermissionRequest = useMemo(
    () => session?.permissionRequests.find((request) => isExternalFilePermissionInput(request.input)) || null,
    [session?.permissionRequests]
  );
  const activeCodexPermissionRequest = useMemo(
    () => session?.permissionRequests.find((request) => isCodexApprovalPermissionInput(request.input)) || null,
    [session?.permissionRequests]
  );

  const genericPermissionQueue = useMemo(
    () =>
      (session?.permissionRequests || []).filter((request) =>
        isAskUserQuestionInput(request.input)
      ),
    [session?.permissionRequests]
  );
  const activeGenericPermissionRequest = genericPermissionQueue[0] || null;

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const droppedSessionId = event.dataTransfer.getData('application/x-aegis-session-id');
    if (!droppedSessionId || !onDropSession) {
      return;
    }
    event.preventDefault();
    onActivate();
    onDropSession(droppedSessionId);
  };

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] transition-colors ${
        isActive
          ? 'bg-[var(--bg-primary)]'
          : 'bg-[color-mix(in_srgb,var(--bg-primary)_96%,var(--bg-secondary))]'
      }`}
      onMouseDown={() => {
        if (!isActive) {
          onActivate();
        }
      }}
      onDragOver={(event) => {
        if (onDropSession) {
          event.preventDefault();
        }
      }}
      onDrop={handleDrop}
    >
      {dropHint ? (
        <div className="pointer-events-none absolute inset-6 z-10 flex items-center justify-center rounded-[var(--radius-2xl)] border-2 border-dashed border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent-light)_75%,transparent)] text-sm font-medium text-[var(--text-primary)]">
          {dropHint}
        </div>
      ) : null}

      {!session ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <div className="text-sm font-medium text-[var(--text-primary)]">Drop a conversation here</div>
            <div className="mt-2 text-sm text-[var(--text-muted)]">
              Drag a thread from the sidebar to open it in this pane.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-9 items-center justify-between bg-[var(--bg-primary)] px-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="truncate font-medium text-[var(--text-primary)]">
                {session.title || 'Chat'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {headerActions}
              {onClose ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Close pane"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
          <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4 relative">
            {isActive ? <InSessionSearch /> : null}

            {session.readOnly && (
              <div className="mb-4 flex justify-center">
                <div className="max-w-[760px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                  This Claude Code session is indexed from your local terminal history. It is read-only in Aegis for now.
                </div>
              </div>
            )}

            <div className="message-container">
              {historyNavigationPending && (
                <div className="mb-4 flex justify-center">
                  <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-secondary)]">
                    {session.loadingMoreHistory ? 'Loading matched message from older history…' : 'Locating matched message…'}
                  </div>
                </div>
              )}

              {session.hasMoreHistory && session.loadingMoreHistory && (
                <div className="mb-4 flex justify-center">
                  <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-secondary)]">
                    Loading older messages…
                  </div>
                </div>
              )}

              <TurnDiffContext.Provider value={turnDiffContextValue}>
                {timelineItems.map((item, idx) => {
                  const turnCard = turnCardByTimelineIndex.get(idx);
                  if (item.type === 'work') {
                    const anchor = String(item.group.originalIndices[0]);
                    const highlighted = highlightedHistoryAnchor === anchor;
                    return (
                      <div key={item.group.id}>
                        <div
                          data-message-index={item.group.originalIndices[0]}
                          className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                          style={
                            highlighted
                              ? {
                                  backgroundColor: 'color-mix(in srgb, var(--accent-light) 70%, transparent)',
                                  boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)',
                                }
                              : undefined
                          }
                        >
                          <ToolExecutionBatch
                            messages={item.group.messages}
                            toolStatusMap={toolStatusMap}
                            toolResultsMap={toolResultsMap}
                            isSessionRunning={session.status === 'running'}
                            isLastBatch={item.active}
                            defaultExpanded={item.defaultExpanded}
                            resetKey={item.disclosureResetKey}
                          />
                        </div>
                        {turnCard ? <TurnChangesCard summary={turnCard} /> : null}
                      </div>
                    );
                  }

                  const anchor = String(item.originalIndex);
                  const highlighted = highlightedHistoryAnchor === anchor;
                  return (
                    <div key={`message-${item.originalIndex}`}>
                      <div
                        data-message-index={item.originalIndex}
                        className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                        style={
                          highlighted
                            ? {
                                backgroundColor: 'color-mix(in srgb, var(--accent-light) 70%, transparent)',
                                boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)',
                              }
                            : undefined
                        }
                      >
                        <MessageCard
                          sessionId={sessionId}
                          message={item.message}
                          toolStatusMap={toolStatusMap}
                          toolResultsMap={toolResultsMap}
                          assistantPresentation={item.assistantPresentation}
                          userPromptActions={
                            item.message.type === 'user_prompt' &&
                            session.readOnly !== true &&
                            (session.provider === 'claude' || session.provider === 'codex' || session.provider === 'opencode')
                              ? {
                                  canEditAndRetry: item.originalIndex === lastUserPromptIndex,
                                  isSessionRunning: session.status === 'running',
                                  onResend: (prompt: string, attachments) => {
                                    if (!sessionId) return;
                                    if (!prompt.trim() && (!attachments || attachments.length === 0)) return;
                                    if (session.status === 'running') return;

                                    sendEvent({
                                      type: 'session.editLatestPrompt',
                                      payload: {
                                        sessionId,
                                        prompt: prompt.trim(),
                                        attachments: attachments && attachments.length > 0 ? attachments : undefined,
                                        provider: session.provider,
                                        model:
                                          session.provider === 'codex'
                                            ? resolveCodexModel(session.model, codexModelConfig) || undefined
                                            : session.model,
                                        compatibleProviderId: session.compatibleProviderId,
                                        betas: session.betas,
                                        claudeAccessMode:
                                          session.provider === 'claude'
                                            ? session.claudeAccessMode || 'default'
                                            : undefined,
                                        claudeExecutionMode:
                                          session.provider === 'claude'
                                            ? session.claudeExecutionMode || 'execute'
                                            : undefined,
                                        codexPermissionMode:
                                          session.provider === 'codex'
                                            ? session.codexPermissionMode || 'defaultPermissions'
                                            : undefined,
                                        codexReasoningEffort:
                                          session.provider === 'codex' ? session.codexReasoningEffort : undefined,
                                        codexFastMode:
                                          session.provider === 'codex' ? session.codexFastMode === true : undefined,
                                        opencodePermissionMode:
                                          session.provider === 'opencode'
                                            ? session.opencodePermissionMode || 'defaultPermissions'
                                            : undefined,
                                      },
                                    });
                                  },
                                }
                              : undefined
                          }
                        />
                        {item.inlineWorkGroup ? (
                          <div className="-mt-1 pl-1">
                            <ToolExecutionBatch
                              messages={item.inlineWorkGroup.messages}
                              toolStatusMap={toolStatusMap}
                              toolResultsMap={toolResultsMap}
                              isSessionRunning={false}
                              defaultExpanded={false}
                            />
                          </div>
                        ) : null}
                      </div>
                      {turnCard ? <TurnChangesCard summary={turnCard} /> : null}
                    </div>
                  );
                })}
              </TurnDiffContext.Provider>

              {(streamingWorkstreamModel || (showPartialMessage && partialMessage)) && (
                <div className="my-2 min-w-0 overflow-x-auto streaming-content">
                  {streamingWorkstreamModel ? (
                    <WorkstreamDisclosure
                      model={streamingWorkstreamModel}
                      isRunning={turnPhase !== 'complete'}
                      defaultExpanded={turnPhase !== 'complete'}
                      resetKey={`${sessionId}:${lastUserPromptIndex}`}
                    />
                  ) : null}
                  {partialMessage ? (
                    <ErrorBoundary
                      resetKey={partialMessage}
                      fallback={
                        <div className="rounded bg-gray-800 p-3">
                          <pre className="whitespace-pre-wrap break-words text-sm text-gray-300">
                            {partialMessage}
                          </pre>
                        </div>
                      }
                    >
                      <StructuredResponse content={partialMessage} streaming />
                    </ErrorBoundary>
                  ) : null}
                </div>
              )}

              {/* Single source of "Working for Xs..." footer during streaming.
                  If the active timeline row is work, that row already renders
                  its own footer, so we suppress this one. */}
              {(() => {
                if (session.status !== 'running') return null;
                const last = timelineItems[timelineItems.length - 1];
                if (last && last.type === 'work' && last.active) return null;
                if (turnPhase === 'complete') return null;
                return <WorkingFooter startedAt={undefined} />;
              })()}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {session.readOnly ? null : (
            <div className="px-8 pb-4">
              {activeGenericPermissionRequest && isAskUserQuestionInput(activeGenericPermissionRequest.input) ? (
                <div className="mb-3 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--accent)]/35 bg-[var(--bg-secondary)] shadow-sm">
                  <div className="flex items-center justify-between gap-3 px-4 py-2">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Permission
                      </span>
                      <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                        · {activeGenericPermissionRequest.toolName}
                      </span>
                    </div>
                    {genericPermissionQueue.length > 1 ? (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-[var(--accent)]/15 px-2 text-[10px] font-medium text-[var(--accent)]">
                        1/{genericPermissionQueue.length}
                      </span>
                    ) : null}
                  </div>
                  <div className="border-t border-[var(--border)]/60 px-4 py-3">
                    <DecisionPanel
                      chrome="bare"
                      input={activeGenericPermissionRequest.input}
                      onSubmit={(result) =>
                        handlePermissionResult(activeGenericPermissionRequest.toolUseId, result)
                      }
                    />
                  </div>
                </div>
              ) : null}
              <PromptInput sessionId={sessionId} />
            </div>
          )}

          {isActive && activeExternalPermissionRequest && isExternalFilePermissionInput(activeExternalPermissionRequest.input) && (
            <ExternalFilePermissionDialog
              input={activeExternalPermissionRequest.input}
              onSubmit={(result) => handlePermissionResult(activeExternalPermissionRequest.toolUseId, result)}
            />
          )}

          {isActive &&
            !activeExternalPermissionRequest &&
            activeCodexPermissionRequest &&
            isCodexApprovalPermissionInput(activeCodexPermissionRequest.input) && (
              <CodexApprovalPermissionDialog
                input={activeCodexPermissionRequest.input}
                onSubmit={(result) => handlePermissionResult(activeCodexPermissionRequest.toolUseId, result)}
              />
            )}

          <TurnDiffDrawer record={selectedDiffRecord} onClose={handleCloseDiff} />
        </>
      )}
    </div>
  );
}
