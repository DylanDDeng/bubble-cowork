import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Clock3,
  FolderOpen,
  KanbanSquare,
  Plus,
  PlayCircle,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
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

function getResolvedTodoStateId(
  todoState: string | null | undefined,
  statusMap: Map<string, StatusConfig>,
  fallbackTodoStateId: string
): string {
  if (todoState && statusMap.has(todoState)) {
    return todoState;
  }

  return fallbackTodoStateId;
}

function sortSessions(left: BoardSession, right: BoardSession): number {
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
    pendingStart,
    projectCwd,
    setActiveSession,
    setActiveWorkspace,
    setPendingStart,
    setShowNewSession,
  } = useAppStore();
  const [groupBy, setGroupBy] = useState<BoardGrouping>('status');
  const [providerFilter, setProviderFilter] = useState<'all' | 'claude' | 'codex' | 'opencode'>('all');
  const [showClosed, setShowClosed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pendingTodoOverrides, setPendingTodoOverrides] = useState<Record<string, string>>({});
  const [knownTodoStates, setKnownTodoStates] = useState<Record<string, string>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);
  const [replyPrompt, setReplyPrompt] = useState('');
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [newRunPrompt, setNewRunPrompt] = useState('');
  const [newRunProvider, setNewRunProvider] = useState<'claude' | 'codex' | 'opencode'>('claude');
  const [newRunCwd, setNewRunCwd] = useState('');

  const statusMap = useMemo(
    () => new Map(statusConfigs.map((status) => [status.id, status])),
    [statusConfigs]
  );
  const fallbackTodoStateId = useMemo(() => {
    if (statusMap.has('todo')) {
      return 'todo';
    }

    const firstOpen = statusConfigs
      .slice()
      .sort((left, right) => left.order - right.order)
      .find((status) => status.category === 'open');

    return firstOpen?.id || statusConfigs[0]?.id || 'todo';
  }, [statusConfigs, statusMap]);

  const boardSessions = useMemo(() => {
    const list = Object.values(sessions)
      .filter((session) => !session.hiddenFromThreads && session.source !== 'claude_code')
      .map((session) => {
        const pendingTodoState = pendingTodoOverrides[session.id];
        const knownTodoState = knownTodoStates[session.id];
        const resolvedTodoState = getResolvedTodoStateId(
          pendingTodoState ?? session.todoState ?? knownTodoState,
          statusMap,
          fallbackTodoStateId
        );
        return resolvedTodoState !== session.todoState
          ? { ...session, todoState: resolvedTodoState }
          : session;
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
        const status = statusMap.get(
          getResolvedTodoStateId(session.todoState, statusMap, fallbackTodoStateId)
        );
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
  }, [fallbackTodoStateId, knownTodoStates, pendingTodoOverrides, providerFilter, searchQuery, sessions, showClosed, statusMap]);

  useEffect(() => {
    setKnownTodoStates((current) => {
      let changed = false;
      const next = { ...current };

      for (const session of Object.values(sessions)) {
        if (session.hiddenFromThreads || session.source === 'claude_code') {
          continue;
        }

        if (session.todoState && statusMap.has(session.todoState) && next[session.id] !== session.todoState) {
          next[session.id] = session.todoState;
          changed = true;
        } else if (!next[session.id]) {
          next[session.id] = fallbackTodoStateId;
          changed = true;
        }
      }

      for (const sessionId of Object.keys(next)) {
        if (!sessions[sessionId]) {
          delete next[sessionId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [fallbackTodoStateId, sessions, statusMap]);

  useEffect(() => {
    setPendingTodoOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const [sessionId, todoState] of Object.entries(current)) {
        const actual = getResolvedTodoStateId(
          sessions[sessionId]?.todoState,
          statusMap,
          fallbackTodoStateId
        );
        if (actual === todoState) {
          delete next[sessionId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [fallbackTodoStateId, sessions, statusMap]);

  useEffect(() => {
    if (!selectedSessionId || !boardSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(boardSessions[0]?.id || null);
    }
  }, [boardSessions, selectedSessionId]);

  const selectedSession = useMemo(
    () => boardSessions.find((session) => session.id === selectedSessionId) || null,
    [boardSessions, selectedSessionId]
  );

  const projectOptions = useMemo(() => {
    const unique = new Set<string>();
    if (projectCwd?.trim()) {
      unique.add(projectCwd.trim());
    }
    for (const session of Object.values(sessions)) {
      if (session.cwd?.trim()) {
        unique.add(session.cwd.trim());
      }
    }
    return Array.from(unique.values()).sort((left, right) => left.localeCompare(right));
  }, [projectCwd, sessions]);

  useEffect(() => {
    if (!selectedSession || selectedSession.hydrated) {
      return;
    }

    sendEvent({
      type: 'session.history',
      payload: { sessionId: selectedSession.id },
    });
  }, [selectedSession]);

  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) {
      return;
    }

    const allSessions = Object.values(sessions).map((session) => {
      const resolvedTodoState = getResolvedTodoStateId(
        pendingTodoOverrides[session.id] ?? session.todoState ?? knownTodoStates[session.id],
        statusMap,
        fallbackTodoStateId
      );
      const resolvedStatus = statusMap.get(resolvedTodoState);
      const query = searchQuery.trim().toLowerCase();
      const excludedReasons: string[] = [];

      if (session.hiddenFromThreads) excludedReasons.push('hiddenFromThreads');
      if (session.source === 'claude_code') excludedReasons.push('externalClaude');
      if (providerFilter !== 'all' && session.provider !== providerFilter) excludedReasons.push('providerFilter');
      if (
        query &&
        !session.title.toLowerCase().includes(query) &&
        !session.cwd?.toLowerCase().includes(query)
      ) {
        excludedReasons.push('searchFilter');
      }
      if (!showClosed && resolvedStatus?.category === 'closed') {
        excludedReasons.push('closedHidden');
      }

      return {
        id: session.id,
        title: session.title,
        status: session.status,
        todoState: session.todoState ?? null,
        knownTodoState: knownTodoStates[session.id] ?? null,
        pendingTodoState: pendingTodoOverrides[session.id] ?? null,
        resolvedTodoState,
        resolvedCategory: resolvedStatus?.category ?? null,
        hiddenFromThreads: session.hiddenFromThreads === true,
        source: session.source ?? null,
        provider: session.provider ?? null,
        included: excludedReasons.length === 0,
        excludedReasons: excludedReasons.join(', ') || null,
      };
    });

    console.groupCollapsed(
      `[BoardView] ${groupBy} view · ${allSessions.filter((item) => item.included).length} visible / ${allSessions.length} total`
    );
    console.table(allSessions);
    console.groupEnd();
  }, [
    fallbackTodoStateId,
    groupBy,
    knownTodoStates,
    pendingTodoOverrides,
    providerFilter,
    searchQuery,
    sessions,
    showClosed,
    statusMap,
  ]);

  useEffect(() => {
    setReplyPrompt('');
  }, [selectedSessionId]);

  useEffect(() => {
    if (!newRunOpen) {
      return;
    }

    if (!newRunCwd && projectOptions.length > 0) {
      setNewRunCwd(projectOptions[0]);
    }
  }, [newRunCwd, newRunOpen, projectOptions]);

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
        sessions: boardSessions.filter(
          (session) => getResolvedTodoStateId(session.todoState, statusMap, fallbackTodoStateId) === status.id
        ),
      }));
  }, [boardSessions, fallbackTodoStateId, groupBy, showClosed, statusConfigs, statusMap]);

  const openThread = (sessionId: string) => {
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setActiveSession(sessionId);
  };

  const requestTodoStateChange = (sessionId: string, todoState: string) => {
    const currentSession = sessions[sessionId];
    const currentTodoState = getResolvedTodoStateId(
      currentSession?.todoState,
      statusMap,
      fallbackTodoStateId
    );
    if (!currentSession || currentTodoState === todoState) {
      return;
    }

    setPendingTodoOverrides((state) => ({
      ...state,
      [sessionId]: todoState,
    }));
    setKnownTodoStates((state) => ({
      ...state,
      [sessionId]: todoState,
    }));
    sendEvent({ type: 'session.setTodoState', payload: { sessionId, todoState } });
  };

  const handleSendReply = () => {
    if (!selectedSession) {
      return;
    }

    if (selectedSession.readOnly) {
      toast.error('This run is read-only.');
      return;
    }

    if (selectedSession.status === 'running') {
      toast.error('This run is already in progress.');
      return;
    }

    const prompt = replyPrompt.trim();
    if (!prompt) {
      return;
    }

    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId: selectedSession.id,
        prompt,
        provider: selectedSession.provider,
        model: selectedSession.model,
        compatibleProviderId: selectedSession.compatibleProviderId,
        betas: selectedSession.betas,
        claudeAccessMode:
          selectedSession.provider === 'claude' ? selectedSession.claudeAccessMode : undefined,
        codexPermissionMode:
          selectedSession.provider === 'codex' ? selectedSession.codexPermissionMode : undefined,
        codexReasoningEffort:
          selectedSession.provider === 'codex' ? selectedSession.codexReasoningEffort : undefined,
        codexFastMode:
          selectedSession.provider === 'codex' ? selectedSession.codexFastMode : undefined,
        opencodePermissionMode:
          selectedSession.provider === 'opencode' ? selectedSession.opencodePermissionMode : undefined,
      },
    });
    setReplyPrompt('');
  };

  const handleStartNewRun = () => {
    const prompt = newRunPrompt.trim();
    const cwd = newRunCwd.trim();

    if (!prompt) {
      toast.error('Enter a prompt to start a new run.');
      return;
    }

    if (!cwd) {
      toast.error('Select a project folder before starting a run.');
      return;
    }

    setPendingStart(true);
    const title = prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '');

    sendEvent({
      type: 'session.start',
      payload: {
        title,
        prompt,
        cwd,
        todoState: 'todo',
        provider: newRunProvider,
      },
    });

    setNewRunPrompt('');
    setNewRunOpen(false);
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
                onClick={() => setNewRunOpen(true)}
                className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <Plus className="h-4 w-4" />
                New Run
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
                              statusConfig={statusMap.get(
                                getResolvedTodoStateId(session.todoState, statusMap, fallbackTodoStateId)
                              )}
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
                    {statusMap.get(
                      getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)
                    ) ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5">
                        <StatusIcon
                          status={
                            statusMap.get(
                              getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)
                            )!
                          }
                        />
                        {
                          statusMap.get(
                            getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)
                          )!.label
                        }
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
                        value={getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)}
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

                <section className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">Reply to Run</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Send a follow-up without leaving the board.
                  </div>
                  <textarea
                    value={replyPrompt}
                    onChange={(event) => setReplyPrompt(event.target.value)}
                    placeholder={
                      selectedSession.readOnly
                        ? 'This run is read-only'
                        : selectedSession.status === 'running'
                          ? 'This run is already in progress'
                          : 'Reply to this run...'
                    }
                    disabled={selectedSession.readOnly || selectedSession.status === 'running'}
                    className="mt-3 min-h-[108px] w-full resize-y rounded-[16px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={handleSendReply}
                      disabled={
                        selectedSession.readOnly ||
                        selectedSession.status === 'running' ||
                        !replyPrompt.trim()
                      }
                      className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Send className="h-4 w-4" />
                      Send
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        </aside>
      </div>

      {newRunOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-2xl rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
              <div>
                <div className="text-base font-semibold text-[var(--text-primary)]">New Run</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  Start a new session directly from the board.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewRunOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                <label className="block">
                  <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Project</div>
                  <input
                    list="board-project-options"
                    value={newRunCwd}
                    onChange={(event) => setNewRunCwd(event.target.value)}
                    placeholder="Select or paste a project path"
                    className="h-11 w-full rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                  />
                  <datalist id="board-project-options">
                    {projectOptions.map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                </label>

                <label className="block">
                  <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Runtime</div>
                  <select
                    value={newRunProvider}
                    onChange={(event) => setNewRunProvider(event.target.value as typeof newRunProvider)}
                    className="h-11 w-full rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none"
                  >
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                </label>
              </div>

              <label className="block">
                <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Prompt</div>
                <textarea
                  value={newRunPrompt}
                  onChange={(event) => setNewRunPrompt(event.target.value)}
                  placeholder="Describe the task you want this run to handle..."
                  className="min-h-[160px] w-full resize-y rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-5 py-4">
              <button
                type="button"
                onClick={() => setNewRunOpen(false)}
                className="inline-flex h-10 items-center rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartNewRun}
                disabled={pendingStart || !newRunPrompt.trim() || !newRunCwd.trim()}
                className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Sparkles className="h-4 w-4" />
                {pendingStart ? 'Starting…' : 'Start Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
