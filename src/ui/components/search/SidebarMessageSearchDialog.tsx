import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowUpRight,
  Clock3,
  FolderOpen,
  LoaderCircle,
  MessageSquareText,
  Search,
  X,
} from 'lucide-react';
import { useDebounce } from '../../hooks/useDebounce';
import { useAppStore } from '../../store/useAppStore';
import { sendEvent } from '../../hooks/useIPC';
import { aggregateMessages } from '../../utils/aggregated-messages';
import { MessageCard } from '../MessageCard';
import { ToolExecutionBatch } from '../ToolExecutionBatch';
import type { ChatSessionSearchResult, ToolStatus } from '../../types';
import { getMessageContentBlocks } from '../../utils/message-content';

function formatSessionSourceLabel(source: ChatSessionSearchResult['sessionSource']): string {
  return source === 'claude_code' ? 'Claude Code' : 'Aegis';
}

function formatMessageTypeLabel(type: ChatSessionSearchResult['matches'][number]['messageType']): string {
  if (type === 'assistant') return 'Assistant';
  if (type === 'user_prompt') return 'Prompt';
  return 'User';
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }

    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), match: false });
    }

    segments.push({
      text: text.slice(matchIndex, matchIndex + normalizedQuery.length),
      match: true,
    });
    cursor = matchIndex + normalizedQuery.length;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${segment.text}-${index}`}
            className="rounded-[4px] bg-[var(--tree-file-accent-fg)]/14 px-0.5 text-[var(--text-primary)]"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        )
      )}
    </>
  );
}

function formatRelativeTimestamp(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < hour) {
    const minutes = Math.max(1, Math.round(deltaMs / minute));
    return `${minutes}m ago`;
  }

  if (deltaMs < day) {
    const hours = Math.max(1, Math.round(deltaMs / hour));
    return `${hours}h ago`;
  }

  const days = Math.max(1, Math.round(deltaMs / day));
  if (days <= 7) {
    return `${days}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(timestamp);
}

function getPathLeaf(cwd: string | undefined): string {
  if (!cwd) return 'No Project';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function HistorySearchResultCard({
  result,
  query,
  selected,
  selectedMessageCreatedAt,
  onSelectSession,
  onSelectMatch,
}: {
  result: ChatSessionSearchResult;
  query: string;
  selected: boolean;
  selectedMessageCreatedAt: number | null;
  onSelectSession: () => void;
  onSelectMatch: (createdAt: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelectSession}
      className={`w-full rounded-[18px] border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-[var(--accent)]/35 bg-[var(--accent-light)]/35'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/20 hover:bg-[var(--bg-tertiary)]/40'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {result.sessionTitle}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              {formatSessionSourceLabel(result.sessionSource)}
            </span>
            <span className="inline-flex items-center gap-1">
              <FolderOpen className="h-3 w-3" />
              {getPathLeaf(result.sessionCwd)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3 w-3" />
              {formatRelativeTimestamp(result.sessionUpdatedAt)}
            </span>
            <span>{result.matchCount} match{result.matchCount === 1 ? '' : 'es'}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {result.matches.map((match) => {
          const isSelectedMatch = selectedMessageCreatedAt === match.createdAt;
          return (
            <button
              key={`${result.sessionId}-${match.createdAt}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectMatch(match.createdAt);
              }}
              className={`block w-full rounded-[12px] border px-3 py-2 text-left transition-colors ${
                isSelectedMatch
                  ? 'border-[var(--accent)]/30 bg-[var(--bg-secondary)]'
                  : 'border-[var(--border)]/60 bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-secondary)]'
              }`}
            >
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                {formatMessageTypeLabel(match.messageType)}
              </div>
              <div className="text-sm leading-6 text-[var(--text-secondary)]">
                <HighlightedSnippet text={match.snippet} query={query} />
              </div>
            </button>
          );
        })}
      </div>
    </button>
  );
}

function PreviewEmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-[420px] text-center">
        <Search className="mx-auto mb-3 h-5 w-5 text-[var(--text-muted)]" />
        <div className="text-sm font-medium text-[var(--text-primary)]">
          Pick a conversation to preview
        </div>
        <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          Search results stay on the left. Select a result card to inspect the full transcript on the right without leaving search.
        </div>
      </div>
    </div>
  );
}

function PreviewLoadingState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <LoaderCircle className="mx-auto mb-3 h-5 w-5 animate-spin text-[var(--text-muted)]" />
        <div className="text-sm font-medium text-[var(--text-primary)]">
          Loading conversation...
        </div>
      </div>
    </div>
  );
}

function SearchHistoryPreview({
  result,
  selectedMessageCreatedAt,
  onOpenInMainThread,
}: {
  result: ChatSessionSearchResult | null;
  selectedMessageCreatedAt: number | null;
  onOpenInMainThread: (sessionId: string, messageCreatedAt: number) => void;
}) {
  const session = useAppStore((state) => (result ? state.sessions[result.sessionId] : null));
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [highlightedAnchor, setHighlightedAnchor] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const historyRequestedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!result || !session || session.hydrated || historyRequestedRef.current.has(result.sessionId)) {
      return;
    }

    historyRequestedRef.current.add(result.sessionId);
    sendEvent({
      type: 'session.history',
      payload: { sessionId: result.sessionId },
    });
  }, [result, session]);

  const aggregatedMessages = useMemo(
    () => (session ? aggregateMessages(session.messages) : []),
    [session?.messages]
  );

  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>();

    if (!session) {
      return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
    }

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
            resultsMap.set(block.tool_use_id, block as { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean });
          }
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [session]);

  const previewAnchor = useMemo(() => {
    if (!session || !selectedMessageCreatedAt) {
      return null;
    }

    for (const item of aggregatedMessages) {
      if (item.type === 'message' && item.message.createdAt === selectedMessageCreatedAt) {
        return String(item.originalIndex);
      }

      if (
        item.type === 'tool_batch' &&
        item.messages.some((message) => message.createdAt === selectedMessageCreatedAt)
      ) {
        return String(item.originalIndices[0]);
      }
    }

    return null;
  }, [aggregatedMessages, selectedMessageCreatedAt, session]);

  useEffect(() => {
    if (!previewAnchor || !previewContainerRef.current || !session?.hydrated) {
      return;
    }

    const messageEl = previewContainerRef.current.querySelector(`[data-preview-message-index="${previewAnchor}"]`);
    if (!messageEl) {
      return;
    }

    messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedAnchor(previewAnchor);

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedAnchor((current) => (current === previewAnchor ? null : current));
      highlightTimerRef.current = null;
    }, 2200);
  }, [previewAnchor, session?.hydrated]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  if (!result) {
    return <PreviewEmptyState />;
  }

  if (!session || !session.hydrated) {
    return <PreviewLoadingState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-[var(--text-primary)]">
              {result.sessionTitle}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
              <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                {formatSessionSourceLabel(result.sessionSource)}
              </span>
              {result.sessionCwd ? (
                <span className="inline-flex items-center gap-1">
                  <FolderOpen className="h-3 w-3" />
                  {result.sessionCwd}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const targetCreatedAt =
                selectedMessageCreatedAt || result.matches[0]?.createdAt || Date.now();
              onOpenInMainThread(result.sessionId, targetCreatedAt);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <ArrowUpRight className="h-4 w-4" />
            Open in Main Thread
          </button>
        </div>
      </div>

      <div ref={previewContainerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="message-container">
          {aggregatedMessages.map((item, index) => {
            const anchor = item.type === 'tool_batch'
              ? String(item.originalIndices[0])
              : String(item.originalIndex);
            const highlighted = highlightedAnchor === anchor;
            const wrapperStyle = highlighted
              ? {
                  backgroundColor: 'color-mix(in srgb, var(--accent-light) 70%, transparent)',
                  boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent)',
                }
              : undefined;

            if (item.type === 'tool_batch') {
              return (
                <div
                  key={`preview-batch-${index}`}
                  data-preview-message-index={anchor}
                  className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                  style={wrapperStyle}
                >
                  <ToolExecutionBatch
                    messages={item.messages}
                    toolStatusMap={toolStatusMap}
                    toolResultsMap={toolResultsMap}
                    isSessionRunning={session.status === 'running'}
                  />
                </div>
              );
            }

            return (
              <div
                key={`preview-message-${index}`}
                data-preview-message-index={anchor}
                className={highlighted ? 'rounded-2xl transition-colors duration-300' : undefined}
                style={wrapperStyle}
              >
                <MessageCard
                  message={item.message}
                  toolStatusMap={toolStatusMap}
                  toolResultsMap={toolResultsMap}
                  permissionRequests={session.permissionRequests}
                  onPermissionResult={() => {}}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SidebarMessageSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const {
    setActiveSession,
    setShowNewSession,
    setShowSettings,
    setHistoryNavigationTarget,
  } = useAppStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatSessionSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedMessageCreatedAt, setSelectedMessageCreatedAt] = useState<number | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedMessageCreatedAtRef = useRef<number | null>(null);
  const debouncedQuery = useDebounce(query, 180);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    selectedMessageCreatedAtRef.current = selectedMessageCreatedAt;
  }, [selectedMessageCreatedAt]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      setSelectedSessionId(null);
      setSelectedMessageCreatedAt(null);
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    let cancelled = false;

    if (!debouncedQuery.trim()) {
      setResults([]);
      setLoading(false);
      setSelectedSessionId(null);
      setSelectedMessageCreatedAt(null);
      return;
    }

    setLoading(true);
    window.electron
      .searchChatMessages(debouncedQuery, 40)
      .then((nextResults) => {
        if (cancelled) return;
        setResults(nextResults);

        const currentResult = selectedSessionIdRef.current
          ? nextResults.find((result) => result.sessionId === selectedSessionIdRef.current)
          : null;

        if (currentResult) {
          const hasCurrentMatch = currentResult.matches.some(
            (match) => match.createdAt === selectedMessageCreatedAtRef.current
          );
          if (!hasCurrentMatch) {
            setSelectedMessageCreatedAt(currentResult.matches[0]?.createdAt || null);
          }
          return;
        }

        const firstResult = nextResults[0];
        setSelectedSessionId(firstResult?.sessionId || null);
        setSelectedMessageCreatedAt(firstResult?.matches[0]?.createdAt || null);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to search chat messages:', error);
          setResults([]);
          setSelectedSessionId(null);
          setSelectedMessageCreatedAt(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const selectedResult = useMemo(
    () => results.find((result) => result.sessionId === selectedSessionId) || null,
    [results, selectedSessionId]
  );

  const summary = useMemo(() => {
    if (!debouncedQuery.trim()) {
      return 'Search indexed conversation history across Aegis and Claude Code';
    }
    if (loading) {
      return 'Searching history...';
    }
    return `${results.length} conversation${results.length === 1 ? '' : 's'}`;
  }, [debouncedQuery, loading, results.length]);

  const openInMainThread = (sessionId: string, messageCreatedAt: number) => {
    setShowSettings(false);
    setShowNewSession(false);
    setHistoryNavigationTarget({
      sessionId,
      messageCreatedAt,
      nonce: Date.now(),
    });
    setActiveSession(sessionId);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[rgba(15,23,42,0.18)] backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[100] flex h-[min(78vh,860px)] w-[min(1180px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-0 shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
                  <MessageSquareText className="h-4.5 w-4.5 text-[var(--text-secondary)]" />
                  <Dialog.Title>Search History</Dialog.Title>
                </div>
                <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">
                  {summary}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Close search"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="relative mt-4">
              <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Aegis and Claude Code history..."
                className="h-11 w-full rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] pl-10 pr-10 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[10px] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex w-[420px] min-w-0 flex-col border-r border-[var(--border)]">
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {!debouncedQuery.trim() ? (
                  <div className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-6 py-12 text-center">
                    <Search className="mb-3 h-5 w-5 text-[var(--text-muted)]" />
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      Search across indexed history
                    </div>
                    <div className="mt-1 max-w-[320px] text-sm leading-6 text-[var(--text-secondary)]">
                      Search your Aegis conversations and imported Claude Code history. Pick a conversation to preview it on the right.
                    </div>
                  </div>
                ) : results.length === 0 && !loading ? (
                  <div className="rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
                    No matching conversations found.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {results.map((result) => (
                      <HistorySearchResultCard
                        key={result.sessionId}
                        result={result}
                        query={debouncedQuery}
                        selected={selectedSessionId === result.sessionId}
                        selectedMessageCreatedAt={
                          selectedSessionId === result.sessionId ? selectedMessageCreatedAt : null
                        }
                        onSelectSession={() => {
                          setSelectedSessionId(result.sessionId);
                          setSelectedMessageCreatedAt(result.matches[0]?.createdAt || null);
                        }}
                        onSelectMatch={(createdAt) => {
                          setSelectedSessionId(result.sessionId);
                          setSelectedMessageCreatedAt(createdAt);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1 bg-[var(--bg-primary)]">
              <SearchHistoryPreview
                result={selectedResult}
                selectedMessageCreatedAt={selectedMessageCreatedAt}
                onOpenInMainThread={openInMainThread}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
