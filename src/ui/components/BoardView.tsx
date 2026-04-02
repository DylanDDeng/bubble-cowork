import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Clock3,
  FolderOpen,
  KanbanSquare,
  PanelRightClose,
  PanelRightOpen,
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
  providerLabel: string;
  modelLabel: string;
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

function getProviderLabel(session: SessionView): string {
  const provider = session.provider || 'claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

function getShortModelLabel(model?: string): string {
  if (!model) return '';
  return model
    .replace(/^claude-/, '')
    .replace(/^codex-/, '')
    .replace(/^opencode-/, '')
    .replace(/-\d{8}$/, '');
}

function getRuntimeLabel(session: SessionView): string {
  const base = getProviderLabel(session);
  const short = getShortModelLabel(session.model);
  return short ? `${base} · ${short}` : base;
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

type ActivityItem = {
  kind: 'prompt' | 'assistant' | 'result' | 'system';
  lines: string[];
};

const ACTIVITY_DOT_COLORS: Record<ActivityItem['kind'], string> = {
  prompt: 'bg-blue-400 dark:bg-blue-500',
  assistant: 'bg-purple-400 dark:bg-purple-500',
  result: 'bg-green-400 dark:bg-green-500',
  system: 'bg-gray-300 dark:bg-gray-500',
};

function getRecentActivityItems(session: SessionView): ActivityItem[] {
  // Collect raw entries newest-first
  const raw: Array<{ role: 'user' | 'ai'; text: string }> = [];
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.type === 'user_prompt' && message.prompt.trim()) {
      raw.push({ role: 'user', text: truncate(message.prompt, 90) });
    } else if (message.type === 'assistant') {
      const summary = extractAssistantSummary(message);
      if (summary !== 'Assistant responded') {
        raw.push({ role: 'ai', text: summary });
      }
    } else if (message.type === 'user') {
      const blocks = getMessageContentBlocks(message);
      const toolResult = blocks.find((block) => block.type === 'tool_result');
      if (toolResult?.content?.trim()) {
        raw.push({ role: 'ai', text: truncate(toolResult.content, 90) });
      }
    } else if (message.type === 'result') {
      raw.push({ role: 'ai', text: message.subtype === 'success' ? 'Completed' : `${message.subtype}` });
    }

    if (raw.length >= 8) {
      break;
    }
  }

  // Group consecutive same-role entries into single timeline nodes
  const items: ActivityItem[] = [];
  for (const entry of raw) {
    const last = items[items.length - 1];
    if (last && ((entry.role === 'user' && last.kind === 'prompt') || (entry.role === 'ai' && last.kind === 'assistant'))) {
      last.lines.push(entry.text);
    } else {
      items.push({
        kind: entry.role === 'user' ? 'prompt' : 'assistant',
        lines: [entry.text],
      });
    }

    if (items.length >= 4) {
      break;
    }
  }

  if (items.length === 0) {
    items.push({ kind: 'system', lines: [session.status === 'running' ? 'Run in progress' : 'No activity yet'] });
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

const COLUMN_ACCENT_COLORS: Record<string, string> = {
  backlog: 'bg-gray-300 dark:bg-gray-600',
  todo: 'bg-blue-400 dark:bg-blue-500',
  'needs-review': 'bg-amber-400 dark:bg-amber-500',
  done: 'bg-green-400 dark:bg-green-500',
  cancelled: 'bg-gray-300 dark:bg-gray-500',
};

const COLUMN_BADGE_COLORS: Record<string, string> = {
  backlog: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  todo: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
  'needs-review': 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
  done: 'bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

function getColumnBadgeClass(columnId: string): string {
  return COLUMN_BADGE_COLORS[columnId] || 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]';
}

function getColumnAccentColor(columnId: string, statusColor?: string): string {
  if (COLUMN_ACCENT_COLORS[columnId]) {
    return COLUMN_ACCENT_COLORS[columnId];
  }
  if (statusColor?.startsWith('#')) {
    return '';
  }
  return 'bg-gray-300 dark:bg-gray-500';
}

function getColumnAccentStyle(columnId: string, statusColor?: string): React.CSSProperties | undefined {
  if (COLUMN_ACCENT_COLORS[columnId]) {
    return undefined;
  }
  if (statusColor?.startsWith('#')) {
    return { backgroundColor: statusColor };
  }
  return undefined;
}

const EXECUTION_STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-400',
  error: 'bg-red-400',
  completed: 'bg-green-400',
  idle: 'bg-gray-300 dark:bg-gray-600',
};

const EXECUTION_LABEL_COLORS: Record<string, string> = {
  Running: 'text-blue-600 dark:text-blue-400',
  Waiting: 'text-amber-600 dark:text-amber-400',
  Error: 'text-red-600 dark:text-red-400',
  Completed: 'text-green-600 dark:text-green-400',
  Idle: 'text-[var(--text-muted)]',
};

function BoardCard({
  session,
  selected,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  session: BoardSession;
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

  const hasActivity = session.latestSummary !== 'No activity yet';
  const statusBarColor = EXECUTION_STATUS_COLORS[session.status] || EXECUTION_STATUS_COLORS.idle;
  const executionLabelColor = EXECUTION_LABEL_COLORS[session.executionLabel] || 'text-[var(--text-muted)]';

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`flex w-full overflow-hidden rounded-[10px] border text-left outline-none transition-all ${
        selected
          ? 'border-blue-400 bg-blue-50/40 shadow-[0_0_0_1px_rgba(96,165,250,0.5)] dark:border-blue-500 dark:bg-blue-950/30 dark:shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-blue-300/50 hover:bg-[var(--bg-secondary)] focus-visible:border-blue-400/50 dark:hover:border-blue-500/30 dark:focus-visible:border-blue-500/40'
      } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <div className={`w-[3px] flex-shrink-0 ${statusBarColor}`} />
      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {session.title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <span className="rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                {session.providerLabel}
              </span>
              {session.modelLabel ? (
                <span className="max-w-[120px] truncate text-[var(--text-muted)]">
                  {session.modelLabel}
                </span>
              ) : null}
              <span className="text-[var(--text-muted)]">·</span>
              <span className={`font-medium ${executionLabelColor}`}>{session.executionLabel}</span>
            </div>
          </div>
          <span className="flex-shrink-0 text-[10px] text-[var(--text-muted)]">{formatRelativeTimestamp(session.updatedAt)}</span>
        </div>

        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <FolderOpen className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{getProjectLabel(session.cwd)}</span>
        </div>

        {hasActivity ? (
          <div className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-[var(--text-secondary)]">
            {session.latestSummary}
          </div>
        ) : null}

        {session.waitingPermission ? (
          <div className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-primary)]">
            <ShieldAlert className="h-3 w-3 text-amber-500" />
            Waiting for permission
          </div>
        ) : null}
      </div>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pendingTodoOverrides, setPendingTodoOverrides] = useState<Record<string, string>>({});
  const [knownTodoStates, setKnownTodoStates] = useState<Record<string, string>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
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
      
      .map((session) => ({
        ...session,
        latestSummary: getLatestActivitySummary(session),
        providerLabel: getProviderLabel(session),
        modelLabel: getShortModelLabel(session.model),
        runtimeLabel: getRuntimeLabel(session),
        executionLabel: getExecutionLabel(session),
        waitingPermission: session.permissionRequests.length > 0,
      })) satisfies BoardSession[];

    return list.sort(sortSessions);
  }, [fallbackTodoStateId, knownTodoStates, pendingTodoOverrides, providerFilter, searchQuery, sessions, statusMap]);

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
      
      .sort((left, right) => left.order - right.order)
      .map((status) => ({
        id: status.id,
        label: status.label,
        status,
        sessions: boardSessions.filter(
          (session) => getResolvedTodoStateId(session.todoState, statusMap, fallbackTodoStateId) === status.id
        ),
      }));
  }, [boardSessions, fallbackTodoStateId, groupBy, statusConfigs, statusMap]);

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
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
              <KanbanSquare className="h-4 w-4 text-[var(--text-secondary)]" />
              Board
            </div>

            <div className="h-4 w-px bg-[var(--border)]" />

            <div className="inline-flex rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
              {(['status', 'runtime'] as BoardGrouping[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGroupBy(mode)}
                  className={`rounded-[8px] px-2.5 py-1 text-[12px] transition-colors ${
                    groupBy === mode
                      ? 'bg-[var(--accent-light)] font-medium text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                  }`}
                >
                  {mode === 'status' ? 'Status' : 'Runtime'}
                </button>
              ))}
            </div>

            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter..."
              className="h-8 w-[160px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />

            <select
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value as typeof providerFilter)}
              className="h-8 rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none"
            >
              <option value="all">All runtimes</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>

            <div className="ml-auto">
              <button
                type="button"
                onClick={() => setNewRunOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                <Plus className="h-3.5 w-3.5" />
                New Run
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 py-4">
            <div className="flex h-full gap-3">
              {columns.map((column) => {
                const runningCount = column.sessions.filter((session) => session.status === 'running').length;
                const blockedCount = column.sessions.filter((session) => session.waitingPermission).length;
                const statusColor = 'status' in column ? column.status?.color : undefined;
                const accentClass = getColumnAccentColor(column.id, statusColor);
                const accentStyle = getColumnAccentStyle(column.id, statusColor);
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
                    className={`flex h-full min-w-[260px] flex-1 flex-col overflow-hidden border bg-[var(--bg-secondary)] transition-colors ${
                      dragOverColumnId === column.id && groupBy === 'status'
                        ? 'border-[var(--accent)]/45 bg-[var(--accent-light)]/20'
                        : 'border-[var(--border)]'
                    }`}
                  >
                    <div
                      className={`h-[3px] flex-shrink-0 ${accentClass}`}
                      style={accentStyle}
                    />
                    <div className="border-b border-[var(--border)] px-4 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          {'status' in column && column.status ? <StatusIcon status={column.status} /> : null}
                          <div className="text-[13px] font-semibold text-[var(--text-primary)]">{column.label}</div>
                        </div>
                        <span className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${getColumnBadgeClass(column.id)}`}>
                          {column.sessions.length}
                        </span>
                      </div>
                      {(runningCount > 0 || blockedCount > 0) ? (
                        <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                          {runningCount > 0 ? `${runningCount} running` : ''}{runningCount > 0 && blockedCount > 0 ? ' · ' : ''}{blockedCount > 0 ? `${blockedCount} waiting` : ''}
                        </div>
                      ) : null}
                    </div>

                    <div className="board-column-scroll min-h-0 flex-1 overflow-y-auto p-2">
                      {column.sessions.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-[12px] text-[var(--text-muted)]">
                          <span className="border-b border-dashed border-[var(--border)]">No runs</span>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {column.sessions.map((session) => (
                            <BoardCard
                              key={session.id}
                              session={session}
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

        {detailOpen ? (
          <aside className="flex w-[340px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-[12px] font-semibold text-[var(--text-secondary)]">Details</span>
              <button
                type="button"
                onClick={() => setDetailOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title="Collapse panel"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </div>

            {!selectedSession ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
                Select a run to inspect
              </div>
            ) : (
              <>
                <div className="board-column-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {/* Header: title */}
                  <div>
                    <div className="text-[14px] font-semibold leading-tight text-[var(--text-primary)]">
                      {selectedSession.title}
                    </div>

                    {/* Tags row */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
                      {(() => {
                        const resolvedId = getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId);
                        const resolvedStatus = statusMap.get(resolvedId);
                        return resolvedStatus ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                            <StatusIcon status={resolvedStatus} className="text-[10px]" />
                            {resolvedStatus.label}
                          </span>
                        ) : null;
                      })()}
                      <span className="rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                        {selectedSession.providerLabel}
                      </span>
                      {selectedSession.modelLabel ? (
                        <span className="text-[var(--text-muted)]">{selectedSession.modelLabel}</span>
                      ) : null}
                      <span className={`font-medium ${EXECUTION_LABEL_COLORS[selectedSession.executionLabel] || 'text-[var(--text-muted)]'}`}>
                        {selectedSession.executionLabel}
                      </span>
                    </div>
                  </div>

                  {/* Meta: project + time in compact two-column */}
                  <div className="mt-3 grid grid-cols-[14px_1fr] gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-muted)]">
                    <FolderOpen className="mt-px h-3.5 w-3.5" />
                    <span className="truncate">{selectedSession.cwd || 'No project'}</span>
                    <Clock3 className="mt-px h-3.5 w-3.5" />
                    <span>{formatRelativeTimestamp(selectedSession.updatedAt)}</span>
                    {selectedSession.waitingPermission ? (
                      <>
                        <ShieldAlert className="mt-px h-3.5 w-3.5 text-amber-500" />
                        <span className="text-amber-600 dark:text-amber-400">Waiting for permission</span>
                      </>
                    ) : null}
                  </div>

                  {/* Actions row */}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openThread(selectedSession.id)}
                      className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-blue-500 text-[12px] font-medium text-white transition-colors hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      Open Thread
                    </button>
                    <select
                      value={getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)}
                      onChange={(event) => requestTodoStateChange(selectedSession.id, event.target.value)}
                      className="h-8 rounded-[8px] border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[11px] text-[var(--text-primary)] outline-none"
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

                  {/* Divider */}
                  <div className="my-3 border-t border-[var(--border)]" />

                  {/* Activity timeline */}
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Activity</div>
                    <div className="mt-2">
                      <div className="space-y-0">
                        {getRecentActivityItems(selectedSession).map((item, index) => (
                          <div
                            key={`${selectedSession.id}-activity-${index}`}
                            className="relative flex gap-2.5"
                          >
                            {/* Dot + line segment */}
                            <div className="relative flex w-[10px] flex-shrink-0 flex-col items-center">
                              <div className="flex h-[18px] items-center justify-center">
                                <div className={`h-[7px] w-[7px] rounded-full ring-2 ring-[var(--bg-secondary)] ${ACTIVITY_DOT_COLORS[item.kind]}`} />
                              </div>
                              {index < getRecentActivityItems(selectedSession).length - 1 ? (
                                <div className="w-px flex-1 bg-[var(--border)]" />
                              ) : null}
                            </div>
                            {/* Content */}
                            <div className="min-w-0 flex-1 pb-3">
                              {item.lines.map((line, lineIndex) => (
                                <div
                                  key={lineIndex}
                                  className="text-[12px] leading-[18px] text-[var(--text-secondary)]"
                                >
                                  {line}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {!selectedSession.hydrated ? (
                      <div className="mt-2 inline-flex items-center gap-1.5 pl-5 text-[11px] text-[var(--text-muted)]">
                        <PlayCircle className="h-3 w-3" />
                        Loading history…
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Reply - fixed bottom bar */}
                <div className="border-t border-[var(--border)] px-3 py-2.5">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={replyPrompt}
                      onChange={(event) => setReplyPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && replyPrompt.trim()) {
                          event.preventDefault();
                          handleSendReply();
                        }
                      }}
                      placeholder={
                        selectedSession.readOnly
                          ? 'Read-only'
                          : selectedSession.status === 'running'
                            ? 'Run in progress…'
                            : 'Reply…'
                      }
                      disabled={selectedSession.readOnly || selectedSession.status === 'running'}
                      rows={1}
                      className="min-h-[32px] max-h-[120px] flex-1 resize-none rounded-[8px] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[12px] leading-[18px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleSendReply}
                      disabled={
                        selectedSession.readOnly ||
                        selectedSession.status === 'running' ||
                        !replyPrompt.trim()
                      }
                      className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[8px] bg-blue-500 text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-500"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        ) : (
          <div className="flex flex-shrink-0 flex-col items-center border-l border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-3">
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title="Expand panel"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          </div>
        )}
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
