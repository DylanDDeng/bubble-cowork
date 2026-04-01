import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Clock3,
  FolderOpen,
  KanbanSquare,
  PlayCircle,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { StatusIcon } from './StatusIcon';
import { getMessageContentBlocks } from '../utils/message-content';
import type { SessionView, StatusConfig, StreamMessage } from '../types';

type BoardGrouping = 'status' | 'runtime';
type RuntimeColumnId = 'claude' | 'codex' | 'opencode' | 'other';

type BoardSession = SessionView & {
  latestSummary: string;
  runtimeLabel: string;
  executionLabel: string;
  waitingPermission: boolean;
};

function truncate(text: string, max = 120): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function getRuntimeLabel(session: SessionView): string {
  const provider = session.provider || 'claude';
  const base =
    provider === 'codex'
      ? 'Codex'
      : provider === 'opencode'
        ? 'OpenCode'
        : 'Claude';
  return session.model ? `${base} · ${session.model}` : base;
}

function getExecutionLabel(session: SessionView): string {
  if (session.status === 'running') {
    return session.permissionRequests.length > 0 ? 'Waiting' : 'Running';
  }
  if (session.status === 'error') {
    return 'Error';
  }
  if (session.status === 'completed') {
    return 'Completed';
  }
  return 'Idle';
}

function extractAssistantSummary(message: Extract<StreamMessage, { type: 'assistant' }>): string {
  const blocks = getMessageContentBlocks(message);
  const textBlock = blocks.find((block) => block.type === 'text');
  if (textBlock?.text?.trim()) {
    return truncate(textBlock.text);
  }

  const toolNames = blocks
    .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => block.name);

  if (toolNames.length > 0) {
    return `Used tools: ${toolNames.slice(0, 3).join(', ')}`;
  }

  return 'Assistant responded';
}

function getLatestActivitySummary(session: SessionView): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.type === 'user_prompt' && message.prompt.trim()) {
      return truncate(message.prompt);
    }
    if (message.type === 'assistant') {
      return extractAssistantSummary(message);
    }
    if (message.type === 'user') {
      const blocks = getMessageContentBlocks(message);
      const toolResult = blocks.find((block) => block.type === 'tool_result');
      if (toolResult?.content?.trim()) {
        return truncate(toolResult.content);
      }
    }
    if (message.type === 'result') {
      return message.subtype === 'success' ? 'Run completed successfully' : `Run ${message.subtype}`;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      return 'Conversation compacted';
    }
  }

  if (session.status === 'running') {
    return session.permissionRequests.length > 0 ? 'Waiting for permission' : 'Run in progress';
  }

  return 'No activity yet';
}

function formatRelativeTimestamp(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < hour) {
    return `${Math.max(1, Math.round(deltaMs / minute))}m ago`;
  }
  if (deltaMs < day) {
    return `${Math.max(1, Math.round(deltaMs / hour))}h ago`;
  }
  return `${Math.max(1, Math.round(deltaMs / day))}d ago`;
}

function getProjectLabel(cwd?: string): string {
  if (!cwd) return 'No Project';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function getRecentActivityItems(session: SessionView): string[] {
  const items: string[] = [];
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.type === 'user_prompt' && message.prompt.trim()) {
      items.push(`Prompt: ${truncate(message.prompt, 90)}`);
    } else if (message.type === 'assistant') {
      items.push(`Assistant: ${extractAssistantSummary(message)}`);
    } else if (message.type === 'user') {
      const blocks = getMessageContentBlocks(message);
      const toolResult = blocks.find((block) => block.type === 'tool_result');
      if (toolResult?.content?.trim()) {
        items.push(`Tool result: ${truncate(toolResult.content, 90)}`);
      }
    } else if (message.type === 'result') {
      items.push(message.subtype === 'success' ? 'Run completed successfully' : `Run ${message.subtype}`);
    }

    if (items.length >= 4) {
      break;
    }
  }

  if (items.length === 0) {
    items.push(session.status === 'running' ? 'Run in progress' : 'No activity yet');
  }

  return items;
}

function getRuntimeColumnId(session: SessionView): RuntimeColumnId {
  if (session.provider === 'codex') return 'codex';
  if (session.provider === 'opencode') return 'opencode';
  if (session.provider === 'claude') return 'claude';
  return 'other';
}

function sortSessions(left: BoardSession, right: BoardSession): number {
  const leftRank =
    left.status === 'running' ? 0 : left.waitingPermission ? 1 : left.status === 'error' ? 2 : 3;
  const rightRank =
    right.status === 'running' ? 0 : right.waitingPermission ? 1 : right.status === 'error' ? 2 : 3;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return right.updatedAt - left.updatedAt;
}

function BoardCard({
  session,
  statusConfig,
  selected,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  session: BoardSession;
  statusConfig?: StatusConfig;
  selected: boolean;
  onSelect: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`w-full rounded-[18px] border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-[var(--accent)]/35 bg-[var(--accent-light)]/35'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/20 hover:bg-[var(--bg-secondary)]'
      } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {session.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
            {statusConfig ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">
                <StatusIcon status={statusConfig} />
                {statusConfig.label}
              </span>
            ) : null}
            <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 font-medium text-[var(--text-secondary)]">
              {session.runtimeLabel}
            </span>
            <span>{session.executionLabel}</span>
          </div>
        </div>
        <span className="text-[11px] text-[var(--text-muted)]">{formatRelativeTimestamp(session.updatedAt)}</span>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="truncate">{getProjectLabel(session.cwd)}</span>
      </div>

      <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
        {session.latestSummary}
      </div>

      {session.waitingPermission ? (
        <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)]">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
          Waiting for permission
        </div>
      ) : null}
    </div>
  );
}

export function BoardView() {
  const {
    sessions,
    statusConfigs,
    setActiveSession,
    setActiveWorkspace,
    setShowNewSession,
  } = useAppStore();
  const [groupBy, setGroupBy] = useState<BoardGrouping>('status');
  const [providerFilter, setProviderFilter] = useState<'all' | 'claude' | 'codex' | 'opencode'>('all');
  const [showClosed, setShowClosed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pendingTodoOverrides, setPendingTodoOverrides] = useState<Record<string, string>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);

  const statusMap = useMemo(
    () => new Map(statusConfigs.map((status) => [status.id, status])),
    [statusConfigs]
  );

  const boardSessions = useMemo(() => {
    const list = Object.values(sessions)
      .filter((session) => !session.hiddenFromThreads && session.source !== 'claude_code')
      .map((session) => {
        const pendingTodoState = pendingTodoOverrides[session.id];
        return pendingTodoState ? { ...session, todoState: pendingTodoState } : session;
      })
      .filter((session) => (providerFilter === 'all' ? true : session.provider === providerFilter))
      .filter((session) => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return true;
        return (
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
        );
      })
      .filter((session) => {
        if (showClosed) return true;
        const status = statusMap.get(session.todoState || 'todo');
        return status ? status.category !== 'closed' : true;
      })
      .map((session) => ({
        ...session,
        latestSummary: getLatestActivitySummary(session),
        runtimeLabel: getRuntimeLabel(session),
        executionLabel: getExecutionLabel(session),
        waitingPermission: session.permissionRequests.length > 0,
      })) satisfies BoardSession[];

    return list.sort(sortSessions);
  }, [pendingTodoOverrides, providerFilter, searchQuery, sessions, showClosed, statusMap]);

  useEffect(() => {
    setPendingTodoOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const [sessionId, todoState] of Object.entries(current)) {
        const actual = sessions[sessionId]?.todoState || 'todo';
        if (actual === todoState) {
          delete next[sessionId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    if (!selectedSessionId || !boardSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(boardSessions[0]?.id || null);
    }
  }, [boardSessions, selectedSessionId]);

  const selectedSession = useMemo(
    () => boardSessions.find((session) => session.id === selectedSessionId) || null,
    [boardSessions, selectedSessionId]
  );

  useEffect(() => {
    if (!selectedSession || selectedSession.hydrated) {
      return;
    }

    sendEvent({
      type: 'session.history',
      payload: { sessionId: selectedSession.id },
    });
  }, [selectedSession]);

  const columns = useMemo(() => {
    if (groupBy === 'runtime') {
      const runtimeDefs: Array<{ id: RuntimeColumnId; label: string }> = [
        { id: 'claude', label: 'Claude' },
        { id: 'codex', label: 'Codex' },
        { id: 'opencode', label: 'OpenCode' },
        { id: 'other', label: 'Other' },
      ];

      return runtimeDefs.map((column) => ({
        id: column.id,
        label: column.label,
        sessions: boardSessions.filter((session) => getRuntimeColumnId(session) === column.id),
      }));
    }

    return statusConfigs
      .filter((status) => (showClosed ? true : status.category !== 'closed'))
      .sort((left, right) => left.order - right.order)
      .map((status) => ({
        id: status.id,
        label: status.label,
        status,
        sessions: boardSessions.filter((session) => (session.todoState || 'todo') === status.id),
      }));
  }, [boardSessions, groupBy, showClosed, statusConfigs]);

  const openThread = (sessionId: string) => {
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setActiveSession(sessionId);
  };

  const requestTodoStateChange = (sessionId: string, todoState: string) => {
    const currentSession = sessions[sessionId];
    if (!currentSession || (currentSession.todoState || 'todo') === todoState) {
      return;
    }

    setPendingTodoOverrides((state) => ({
      ...state,
      [sessionId]: todoState,
    }));
    sendEvent({ type: 'session.setTodoState', payload: { sessionId, todoState } });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
      <div className="h-8 drag-region flex-shrink-0 border-b border-[var(--border)]" />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-[var(--border)] px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
                  <KanbanSquare className="h-4.5 w-4.5 text-[var(--text-secondary)]" />
                  Board
                </div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  Track active runs by workflow status or runtime.
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setActiveWorkspace('chat');
                  setActiveSession(null);
                  setShowNewSession(true);
                }}
                className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <Sparkles className="h-4 w-4" />
                New Thread
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] p-1">
                {(['status', 'runtime'] as BoardGrouping[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGroupBy(mode)}
                    className={`rounded-[10px] px-3 py-1.5 text-sm transition-colors ${
                      groupBy === mode
                        ? 'bg-[var(--accent-light)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    {mode === 'status' ? 'By Status' : 'By Runtime'}
                  </button>
                ))}
              </div>

              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Filter by title or project..."
                className="h-10 min-w-[240px] rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />

              <select
                value={providerFilter}
                onChange={(event) => setProviderFilter(event.target.value as typeof providerFilter)}
                className="h-10 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none"
              >
                <option value="all">All runtimes</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
              </select>

              <label className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(event) => setShowClosed(event.target.checked)}
                  className="h-4 w-4 rounded border-[var(--border)]"
                />
                Show closed
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 py-4">
            <div className="flex h-full min-w-max gap-4">
              {columns.map((column) => {
                const runningCount = column.sessions.filter((session) => session.status === 'running').length;
                const blockedCount = column.sessions.filter((session) => session.waitingPermission).length;
                return (
                  <div
                    key={column.id}
                    onDragOver={
                      groupBy === 'status'
                        ? (event) => {
                            event.preventDefault();
                            setDragOverColumnId(column.id);
                          }
                        : undefined
                    }
                    onDragLeave={
                      groupBy === 'status'
                        ? () => {
                            setDragOverColumnId((current) => (current === column.id ? null : current));
                          }
                        : undefined
                    }
                    onDrop={
                      groupBy === 'status'
                        ? (event) => {
                            event.preventDefault();
                            const sessionId = event.dataTransfer.getData('text/plain') || draggingSessionId;
                            if (sessionId) {
                              requestTodoStateChange(sessionId, column.id);
                            }
                            setDragOverColumnId(null);
                            setDraggingSessionId(null);
                          }
                        : undefined
                    }
                    className={`flex h-full w-[320px] flex-shrink-0 flex-col rounded-[22px] border bg-[var(--bg-secondary)] transition-colors ${
                      dragOverColumnId === column.id && groupBy === 'status'
                        ? 'border-[var(--accent)]/45 bg-[var(--accent-light)]/20'
                        : 'border-[var(--border)]'
                    }`}
                  >
                    <div className="border-b border-[var(--border)] px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          {'status' in column && column.status ? <StatusIcon status={column.status} /> : null}
                          <div className="text-sm font-semibold text-[var(--text-primary)]">{column.label}</div>
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">{column.sessions.length}</div>
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-muted)]">
                        {runningCount} running · {blockedCount} waiting
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-3">
                      {column.sessions.length === 0 ? (
                        <div className="rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                          No runs in this column.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {column.sessions.map((session) => (
                            <BoardCard
                              key={session.id}
                              session={session}
                              statusConfig={statusMap.get(session.todoState || 'todo')}
                              selected={selectedSessionId === session.id}
                              onSelect={() => setSelectedSessionId(session.id)}
                              draggable={groupBy === 'status'}
                              onDragStart={() => setDraggingSessionId(session.id)}
                              onDragEnd={() => {
                                setDraggingSessionId(null);
                                setDragOverColumnId(null);
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="flex w-[360px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Run Details</div>
            <div className="mt-1 text-sm text-[var(--text-secondary)]">
              Inspect the selected run without leaving the board.
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {!selectedSession ? (
              <div className="rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-5 py-8 text-center text-sm text-[var(--text-secondary)]">
                Pick a run card to inspect its runtime, status, and recent activity.
              </div>
            ) : (
              <div className="space-y-4">
                <section className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-base font-semibold text-[var(--text-primary)]">{selectedSession.title}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                    {statusMap.get(selectedSession.todoState || 'todo') ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">
                        <StatusIcon status={statusMap.get(selectedSession.todoState || 'todo')!} />
                        {statusMap.get(selectedSession.todoState || 'todo')!.label}
                      </span>
                    ) : null}
                    <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 text-[var(--text-secondary)]">
                      {selectedSession.runtimeLabel}
                    </span>
                    <span>{selectedSession.executionLabel}</span>
                  </div>

                  <div className="mt-4 space-y-2 text-sm text-[var(--text-secondary)]">
                    <div className="flex items-center justify-between gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
                      <span className="text-sm text-[var(--text-secondary)]">Status</span>
                      <select
                        value={selectedSession.todoState || 'todo'}
                        onChange={(event) => requestTodoStateChange(selectedSession.id, event.target.value)}
                        className="h-9 rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none"
                      >
                        {statusConfigs
                          .slice()
                          .sort((left, right) => left.order - right.order)
                          .map((status) => (
                            <option key={status.id} value={status.id}>
                              {status.label}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <FolderOpen className="h-4 w-4 text-[var(--text-muted)]" />
                      <span className="truncate">{selectedSession.cwd || 'No project selected'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-[var(--text-muted)]" />
                      <span>Updated {formatRelativeTimestamp(selectedSession.updatedAt)}</span>
                    </div>
                    {selectedSession.waitingPermission ? (
                      <div className="flex items-center gap-2 text-amber-600">
                        <ShieldAlert className="h-4 w-4" />
                        <span>Waiting for permission approval</span>
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => openThread(selectedSession.id)}
                    className="mt-4 inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                  >
                    <ArrowUpRight className="h-4 w-4" />
                    Open Thread
                  </button>
                </section>

                <section className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">Latest Activity</div>
                  <div className="mt-3 space-y-2">
                    {getRecentActivityItems(selectedSession).map((item, index) => (
                      <div
                        key={`${selectedSession.id}-activity-${index}`}
                        className="rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)]"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">Run Snapshot</div>
                  <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                    {selectedSession.latestSummary}
                  </div>
                  {!selectedSession.hydrated ? (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1 text-xs text-[var(--text-secondary)]">
                      <PlayCircle className="h-3.5 w-3.5" />
                      Loading session history…
                    </div>
                  ) : null}
                </section>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
