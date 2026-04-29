import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
  User,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
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
  return short ? `${base} ${short}` : base;
}

function RuntimeLogo({ provider, className = 'h-3.5 w-3.5' }: { provider: string; className?: string }) {
  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
  }
  if (provider === 'opencode') {
    return <OpenCodeLogo className={`${className} flex-shrink-0`} />;
  }
  return <img src={claudeLogo} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
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

// A "turn" represents one user prompt and the agent work that followed it.
type ActivityTurn = {
  prompt: string;
  textSummaries: string[];
  toolNames: string[];
  result: string | null;
};

function collectActivityTurns(session: SessionView): ActivityTurn[] {
  const turns: ActivityTurn[] = [];
  let current: ActivityTurn | null = null;

  for (const message of session.messages) {
    if (message.type === 'user_prompt' && message.prompt.trim()) {
      if (current) {
        turns.push(current);
      }
      current = { prompt: truncate(message.prompt, 120), textSummaries: [], toolNames: [], result: null };
    } else if (!current) {
      continue;
    } else if (message.type === 'assistant') {
      const blocks = getMessageContentBlocks(message);
      const textBlock = blocks.find((b) => b.type === 'text');
      if (textBlock?.text?.trim()) {
        current.textSummaries.push(truncate(textBlock.text, 100));
      }
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name && !current.toolNames.includes(block.name)) {
          current.toolNames.push(block.name);
        }
      }
    } else if (message.type === 'result') {
      current.result = message.subtype === 'success' ? 'Completed' : message.subtype;
    }
  }

  if (current) {
    turns.push(current);
  }

  if (session.status === 'running' && turns.length === 0) {
    return [{ prompt: 'Run in progress', textSummaries: [], toolNames: [], result: null }];
  }

  return turns;
}

function ActivityTurnItem({
  turn,
  index,
  total,
  provider,
  defaultExpanded,
}: {
  turn: ActivityTurn;
  index: number;
  total: number;
  provider: string;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasDetails = turn.textSummaries.length > 0 || turn.toolNames.length > 0 || turn.result !== null;
  const isLast = index === total - 1;

  const toggle = useCallback(() => {
    if (hasDetails) {
      setExpanded((prev) => !prev);
    }
  }, [hasDetails]);

  return (
    <div className="relative flex gap-2.5">
      {/* Icon column + connector line */}
      <div className="relative flex w-[16px] flex-shrink-0 flex-col items-center">
        <div className="flex h-[20px] items-center justify-center">
          <div className="h-[16px] w-[16px] flex items-center justify-center rounded-full bg-blue-500/15 text-blue-500">
            <User className="h-[10px] w-[10px]" />
          </div>
        </div>
        {(!isLast || (expanded && hasDetails)) ? (
          <div className="w-px flex-1 bg-[var(--border)]" />
        ) : null}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-2">
        {/* Prompt row */}
        <button
          type="button"
          onClick={toggle}
          className={`flex w-full items-start gap-1 text-left ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {hasDetails ? (
            expanded
              ? <ChevronDown className="mt-[3px] h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
              : <ChevronRight className="mt-[3px] h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
          ) : (
            <span className="mt-[3px] inline-block h-3 w-3 flex-shrink-0" />
          )}
          <span className="text-[12px] leading-[20px] font-medium text-[var(--text-primary)]">
            {turn.prompt}
          </span>
        </button>

        {/* Expanded agent details */}
        {expanded && hasDetails && (
          <div className="mt-1 ml-4 space-y-1">
            {/* Text summaries */}
            {turn.textSummaries.length > 0 && (
              <div className="relative flex gap-2 items-start">
                <div className="flex h-[18px] w-[16px] flex-shrink-0 items-center justify-center">
                  <RuntimeLogo provider={provider} className="h-[14px] w-[14px] flex-shrink-0" />
                </div>
                <div className="min-w-0 flex-1">
                  {turn.textSummaries.map((line, lineIndex) => (
                    <div key={lineIndex} className="text-[11px] leading-[18px] text-[var(--text-secondary)]">{line}</div>
                  ))}
                </div>
              </div>
            )}
            {/* Tool usage badge */}
            {turn.toolNames.length > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                <Sparkles className="h-3 w-3 flex-shrink-0" />
                <span>{turn.toolNames.length} tool{turn.toolNames.length > 1 ? 's' : ''}: {turn.toolNames.slice(0, 4).join(', ')}{turn.toolNames.length > 4 ? ` +${turn.toolNames.length - 4}` : ''}</span>
              </div>
            )}
            {/* Result */}
            {turn.result && (
              <div className="relative flex gap-2 items-start">
                <div className="flex h-[18px] w-[16px] flex-shrink-0 items-center justify-center">
                  <div className="h-[14px] w-[14px] flex items-center justify-center rounded-full bg-green-500/15 text-green-500">
                    <CheckCircle2 className="h-[9px] w-[9px]" />
                  </div>
                </div>
                <div className="text-[11px] leading-[18px] text-[var(--text-secondary)]">{turn.result}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDropdown({
  value,
  statusConfigs: configs,
  onChange,
}: {
  value: string;
  statusConfigs: StatusConfig[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sorted = useMemo(
    () => configs.slice().sort((a, b) => a.order - b.order),
    [configs]
  );
  const current = sorted.find((s) => s.id === value) || sorted[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[11px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--bg-secondary)]"
      >
        {current && <StatusIcon status={current} className="text-[10px]" />}
        <span>{current?.label}</span>
        <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
      </button>
      {open && (
        <div className="popover-surface absolute right-0 top-full z-50 mt-2 min-w-[140px] overflow-hidden p-1">
          {sorted.map((status) => (
            <button
              key={status.id}
              type="button"
              onClick={() => { onChange(status.id); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--bg-tertiary)] ${
                status.id === value ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              <StatusIcon status={status} className="text-[10px]" />
              <span>{status.label}</span>
              {status.id === value ? <Check className="ml-auto h-3 w-3 text-[var(--accent)]" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_VISIBLE_TURNS = 5;

function ActivityTimeline({ session }: { session: BoardSession }) {
  const turns = useMemo(() => collectActivityTurns(session), [session.messages, session.status]);
  const [showAll, setShowAll] = useState(false);

  const provider = session.provider || 'claude';
  const hasManyTurns = turns.length > MAX_VISIBLE_TURNS;
  const visibleTurns = showAll ? turns : turns.slice(-MAX_VISIBLE_TURNS);
  const hiddenCount = turns.length - visibleTurns.length;

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Activity
        {turns.length > 1 ? (
          <span className="ml-1.5 font-normal normal-case tracking-normal text-[var(--text-muted)]">
            ({turns.length} turns)
          </span>
        ) : null}
      </div>
      <div className="mt-2">
        {hasManyTurns && !showAll ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mb-2 text-[11px] text-[var(--accent)] hover:underline"
          >
            Show {hiddenCount} older turn{hiddenCount > 1 ? 's' : ''}
          </button>
        ) : null}
        <div className="space-y-0">
          {visibleTurns.map((turn, index) => (
            <ActivityTurnItem
              key={`${session.id}-turn-${turns.length - visibleTurns.length + index}`}
              turn={turn}
              index={index}
              total={visibleTurns.length}
              provider={provider}
              defaultExpanded={index === visibleTurns.length - 1}
            />
          ))}
        </div>
        {turns.length === 0 && session.hydrated ? (
          <div className="text-[12px] text-[var(--text-muted)]">No activity yet</div>
        ) : null}
        {!session.hydrated ? (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <PlayCircle className="h-3 w-3" />
            Loading history…
          </div>
        ) : null}
      </div>
    </div>
  );
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
      className={`flex w-full overflow-hidden rounded-[var(--radius-lg)] border text-left outline-none transition-all ${
        selected
          ? 'border-[var(--accent)]/40 bg-[var(--accent-light)] shadow-[0_0_0_1px_var(--accent)]/20'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/25 hover:bg-[var(--bg-secondary)] focus-visible:border-[var(--accent)]/40'
      } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <div className={`w-[3px] flex-shrink-0 ${statusBarColor}`} />
      <div className="min-w-0 flex-1 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {session.title}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1 truncate rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                <RuntimeLogo provider={session.provider || 'claude'} className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{session.runtimeLabel}</span>
              </span>
              <span className="text-[var(--text-muted)]">·</span>
              <span className={`flex-shrink-0 font-medium ${executionLabelColor}`}>{session.executionLabel}</span>
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
      .filter((session) => !session.hiddenFromThreads && session.source !== 'claude_code' && !session.isDraft)
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
        if (session.hiddenFromThreads || session.source === 'claude_code' || session.isDraft) {
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

            <div className="inline-flex rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
              {(['status', 'runtime'] as BoardGrouping[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGroupBy(mode)}
                  className={`rounded-[var(--radius-md)] px-2.5 py-1 text-[12px] transition-colors ${
                    groupBy === mode
                      ? 'bg-[var(--accent-light)] font-medium text-[var(--accent)]'
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
              className="h-8 w-[160px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />

            <select
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value as typeof providerFilter)}
              className="h-8 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none"
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
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--accent)]/20 bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
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
                    className={`flex h-full min-w-[260px] flex-1 flex-col overflow-hidden rounded-[var(--radius-xl)] border bg-[var(--bg-secondary)] transition-colors ${
                      dragOverColumnId === column.id && groupBy === 'status'
                        ? 'border-[var(--accent)]/45 bg-[var(--accent-light)]/20'
                        : 'border-[var(--border)]'
                    }`}
                  >
                    <div
                      className={`h-[3px] flex-shrink-0 rounded-t-[var(--radius-xl)] ${accentClass}`}
                      style={accentStyle}
                    />
                    <div className="border-b border-[var(--border)] px-4 py-3">
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
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
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
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                        <RuntimeLogo provider={selectedSession.provider || 'claude'} className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{selectedSession.runtimeLabel}</span>
                      </span>
                    </div>
                  </div>

                  {/* Meta: project + time in compact two-column */}
                  <div className="mt-3 grid grid-cols-[14px_1fr] gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-muted)]">
                    <FolderOpen className="mt-px h-3.5 w-3.5" />
                    <span className="truncate" title={selectedSession.cwd || undefined}>.../{getProjectLabel(selectedSession.cwd)}</span>
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
                      className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      Open Thread
                    </button>
                    <StatusDropdown
                      value={getResolvedTodoStateId(selectedSession.todoState, statusMap, fallbackTodoStateId)}
                      statusConfigs={statusConfigs}
                      onChange={(id) => requestTodoStateChange(selectedSession.id, id)}
                    />
                  </div>

                  {/* Divider */}
                  <div className="my-3 border-t border-[var(--border)]" />

                  {/* Activity timeline (turn-based) */}
                  <ActivityTimeline session={selectedSession} />
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
                      className="min-h-[32px] max-h-[120px] flex-1 resize-none rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[12px] leading-[18px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={handleSendReply}
                      disabled={
                        selectedSession.readOnly ||
                        selectedSession.status === 'running' ||
                        !replyPrompt.trim()
                      }
                      className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
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
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title="Expand panel"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {newRunOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-2xl rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
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
                    className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
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
                    className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none"
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
                  className="min-h-[160px] w-full resize-y rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-5 py-4">
              <button
                type="button"
                onClick={() => setNewRunOpen(false)}
                className="inline-flex h-10 items-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartNewRun}
                disabled={pendingStart || !newRunPrompt.trim() || !newRunCwd.trim()}
                className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
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
