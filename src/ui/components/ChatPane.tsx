import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { toast } from 'sonner';
import { sendEvent } from '../hooks/useIPC';
import { useAppStore } from '../store/useAppStore';
import { aggregateMessages } from '../utils/aggregated-messages';
import { createStreamingWorkstreamModel } from '../utils/workstream';
import { deriveTurnPhase, hasRunningToolInMessages } from '../utils/turn-utils';
import { getMessageContentBlocks } from '../utils/message-content';
import { resolveCodexModel } from '../utils/codex-model';
import { MessageCard } from './MessageCard';
import { ToolExecutionBatch } from './ToolExecutionBatch';
import { StructuredResponse } from './StructuredResponse';
import { AssistantWorkstream } from './AssistantWorkstream';
import { PromptInput } from './PromptInput';
import { InSessionSearch } from './search/InSessionSearch';
import { DecisionPanel } from './DecisionPanel';
import { ExternalFilePermissionDialog } from './ExternalFilePermissionDialog';
import { ErrorBoundary } from './ErrorBoundary';
import type {
  AskUserQuestionInput,
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

function getPathLeaf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || path;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex h-5 items-center rounded-md px-1.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
      title="Copy path"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
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

  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!session) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of session.messages) {
      if (msg.type === 'assistant') {
        for (const block of getMessageContentBlocks(msg)) {
          if (block.type === 'tool_use') {
            statusMap.set(block.id, 'pending');
          }
        }
      } else if (msg.type === 'user') {
        for (const block of getMessageContentBlocks(msg)) {
          if (block.type === 'tool_result') {
            statusMap.set(block.tool_use_id, block.is_error ? 'error' : 'success');
            resultsMap.set(block.tool_use_id, block as ToolResultBlock);
          }
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [session?.messages]);

  const turnPhase = useMemo(() => {
    if (!session) return 'complete' as const;

    const isRunning = session.status === 'running';
    const hasRunningTool = hasRunningToolInMessages(session.messages, toolStatusMap);
    const isStreaming = showPartialMessage;

    return deriveTurnPhase(session.messages, isRunning, hasRunningTool, isStreaming);
  }, [session?.messages, session?.status, toolStatusMap, showPartialMessage]);

  const aggregatedMessages = useMemo(
    () => (session ? aggregateMessages(session.messages) : []),
    [session?.messages]
  );

  const historyNavigationAnchor = useMemo(() => {
    if (!sessionId || !historyNavigationTarget || historyNavigationTarget.sessionId !== sessionId) {
      return null;
    }

    for (const item of aggregatedMessages) {
      if (item.type === 'message' && item.message.createdAt === historyNavigationTarget.messageCreatedAt) {
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
  }, [aggregatedMessages, historyNavigationTarget, sessionId]);

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
    showPartialMessage,
  ]);

  useEffect(() => {
    prevMessageCountRef.current = 0;
    scrollHeightBeforeLoadRef.current = 0;
    setHighlightedHistoryAnchor(null);
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

  const activeGenericPermissionRequest = useMemo(
    () => session?.permissionRequests.find((request) => isAskUserQuestionInput(request.input)) || null,
    [session?.permissionRequests]
  );

  const lastUserPromptIndex = useMemo(() => {
    if (!session) return -1;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      if (session.messages[i]?.type === 'user_prompt') {
        return i;
      }
    }
    return -1;
  }, [session?.messages]);

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
          ? 'ring-1 ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent)_10%,transparent)]'
          : 'bg-[color-mix(in_srgb,var(--bg-primary)_96%,var(--bg-secondary))]'
      }`}
      onMouseDown={onActivate}
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
          <div className="flex h-9 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-primary)] px-3">
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

            {session.cwd && (
              <div className="mb-4 flex justify-center">
                <div
                  className="inline-flex max-w-[760px] flex-wrap items-center justify-center gap-1.5 text-xs text-[var(--text-muted)]"
                  title={session.cwd}
                >
                  {session.source === 'claude_code' && (
                    <span className="rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-2 py-0.5 uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                      Claude Code
                    </span>
                  )}
                  <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
                    <FolderOpen className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate font-mono">.../{getPathLeaf(session.cwd)}</span>
                  <CopyButton text={session.cwd} />
                </div>
              </div>
            )}

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

              {aggregatedMessages.map((item, idx) => {
                if (item.type === 'tool_batch') {
                  const anchor = String(item.originalIndices[0]);
                  const highlighted = highlightedHistoryAnchor === anchor;
                  return (
                    <div
                      key={`batch-${idx}`}
                      data-message-index={item.originalIndices[0]}
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
                        messages={item.messages}
                        toolStatusMap={toolStatusMap}
                        toolResultsMap={toolResultsMap}
                        isSessionRunning={session.status === 'running'}
                        cwd={session.cwd || null}
                      />
                    </div>
                  );
                }

                const anchor = String(item.originalIndex);
                const highlighted = highlightedHistoryAnchor === anchor;
                return (
                  <div
                    key={idx}
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
                      permissionRequests={session.permissionRequests}
                      onPermissionResult={handlePermissionResult}
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
                  </div>
                );
              })}

              {(streamingWorkstreamModel || (showPartialMessage && partialMessage)) && (
                <div className="my-3 min-w-0 overflow-x-auto streaming-content">
                  {streamingWorkstreamModel && <AssistantWorkstream model={streamingWorkstreamModel} />}
                  {partialMessage && (
                    <ErrorBoundary
                      resetKey={partialMessage}
                      fallback={
                        <div className="p-3 bg-gray-800 rounded-lg">
                          <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words">{partialMessage}</pre>
                        </div>
                      }
                    >
                      <StructuredResponse content={partialMessage} streaming />
                    </ErrorBoundary>
                  )}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {session.readOnly ? null : (
            <div className="px-8 pb-4">
              <PromptInput sessionId={sessionId} />
            </div>
          )}

          {isActive && activeExternalPermissionRequest && isExternalFilePermissionInput(activeExternalPermissionRequest.input) && (
            <ExternalFilePermissionDialog
              input={activeExternalPermissionRequest.input}
              onSubmit={(result) => handlePermissionResult(activeExternalPermissionRequest.toolUseId, result)}
            />
          )}

          {isActive && activeGenericPermissionRequest && isAskUserQuestionInput(activeGenericPermissionRequest.input) && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
              <div className="w-full max-w-2xl rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-2xl">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Permission Request
                </div>
                <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
                  {activeGenericPermissionRequest.toolName}
                </div>
                <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  The agent needs your approval before continuing.
                </div>
                <DecisionPanel
                  input={activeGenericPermissionRequest.input}
                  onSubmit={(result) => handlePermissionResult(activeGenericPermissionRequest.toolUseId, result)}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
