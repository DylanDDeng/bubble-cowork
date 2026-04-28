import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  FileDiff,
  FolderOpen,
  KanbanSquare,
  Layers3,
  PanelRightClose,
  PanelRightOpen,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { getMessageContentBlocks } from '../utils/message-content';
import { buildTurnChangeContext } from '../utils/turn-change-records';
import type { AgentProvider, AgentRun, BoardTask, TaskStatus } from '../../shared/types';
import type { SessionView, StreamMessage } from '../types';

type DetailTab = 'runs' | 'activity' | 'changes' | 'artifacts';
type RunDialogMode = 'new-task' | 'existing-task';

type TaskColumn = {
  id: TaskStatus;
  label: string;
  description: string;
  accent: string;
};

const TASK_COLUMNS: TaskColumn[] = [
  { id: 'todo', label: 'Todo', description: 'Ready to run', accent: 'bg-blue-400 dark:bg-blue-500' },
  { id: 'running', label: 'Running', description: 'Agent is working', accent: 'bg-cyan-400 dark:bg-cyan-500' },
  { id: 'needs_review', label: 'Needs Review', description: 'Human acceptance required', accent: 'bg-amber-400 dark:bg-amber-500' },
  { id: 'done', label: 'Done', description: 'Accepted result', accent: 'bg-green-400 dark:bg-green-500' },
  { id: 'cancelled', label: 'Cancelled', description: 'No longer active', accent: 'bg-gray-300 dark:bg-gray-600' },
];

const TASK_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  running: 'Running',
  needs_review: 'Needs Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const RUN_STATUS_LABELS: Record<AgentRun['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_permission: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const RUN_STATUS_COLORS: Record<AgentRun['status'], string> = {
  queued: 'text-[var(--text-muted)]',
  running: 'text-blue-600 dark:text-blue-400',
  waiting_permission: 'text-amber-600 dark:text-amber-400',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  cancelled: 'text-[var(--text-muted)]',
};

const TEST_STATUS_LABELS: Record<NonNullable<AgentRun['testStatus']>, string> = {
  unknown: 'Validation',
  passed: 'Passed',
  failed: 'Failed',
};

const TEST_STATUS_COLORS: Record<NonNullable<AgentRun['testStatus']>, string> = {
  unknown: 'border-[var(--border)] text-[var(--text-muted)]',
  passed: 'border-green-500/25 bg-green-500/10 text-green-600 dark:text-green-400',
  failed: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400',
};

function truncate(text: string, max = 120): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function RuntimeLogo({ provider, className = 'h-3.5 w-3.5' }: { provider: AgentProvider; className?: string }) {
  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
  }
  if (provider === 'opencode') {
    return <OpenCodeLogo className={`${className} flex-shrink-0`} />;
  }
  return <img src={claudeLogo} alt="" className={`${className} flex-shrink-0`} aria-hidden="true" />;
}

function getProviderLabel(provider?: AgentProvider): string {
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

function getProjectLabel(cwd?: string): string {
  if (!cwd) return 'No Project';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
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

function extractAssistantSummary(message: Extract<StreamMessage, { type: 'assistant' }>): string {
  const blocks = getMessageContentBlocks(message);
  const textBlock = blocks.find((block) => block.type === 'text');
  if (textBlock?.text?.trim()) {
    return truncate(textBlock.text, 140);
  }

  const toolNames = blocks
    .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => block.name);

  if (toolNames.length > 0) {
    return `Used tools: ${toolNames.slice(0, 3).join(', ')}`;
  }

  return 'Assistant responded';
}

function getLatestActivitySummary(session?: SessionView): string {
  if (!session) return 'No run activity yet';

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.type === 'assistant') return extractAssistantSummary(message);
    if (message.type === 'user_prompt' && message.prompt.trim()) return truncate(message.prompt, 140);
    if (message.type === 'result') {
      return message.subtype === 'success' ? 'Run completed successfully' : `Run ${message.subtype}`;
    }
  }

  if (session.status === 'running') {
    return session.permissionRequests.length > 0 ? 'Waiting for permission' : 'Run in progress';
  }
  return 'No activity yet';
}

function getRunSortValue(run: AgentRun): number {
  return run.completedAt || run.startedAt;
}

function getRunsForTask(taskId: string, runs: AgentRun[]): AgentRun[] {
  return runs
    .filter((run) => run.taskId === taskId)
    .sort((left, right) => getRunSortValue(right) - getRunSortValue(left));
}

function getLatestRun(taskId: string, runs: AgentRun[]): AgentRun | null {
  return getRunsForTask(taskId, runs)[0] || null;
}

function getTaskUpdatedAt(task: BoardTask, runs: AgentRun[]): number {
  const latest = getLatestRun(task.id, runs);
  return Math.max(task.updatedAt, latest?.completedAt || latest?.startedAt || 0);
}

function getChangeSummary(session?: SessionView) {
  if (!session) {
    return { files: 0, added: 0, removed: 0 };
  }
  const context = buildTurnChangeContext(session.messages);
  return context.turns.reduce(
    (acc, turn) => ({
      files: acc.files + turn.totalFiles,
      added: acc.added + turn.totalAdded,
      removed: acc.removed + turn.totalRemoved,
    }),
    { files: 0, added: 0, removed: 0 }
  );
}

function TaskCard({
  task,
  latestRun,
  latestSession,
  runCount,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  task: BoardTask;
  latestRun: AgentRun | null;
  latestSession?: SessionView;
  runCount: number;
  selected: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  const changeSummary = getChangeSummary(latestSession);
  const status = latestRun?.status || 'queued';
  const runStatusClass = RUN_STATUS_COLORS[status];

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`flex w-full cursor-grab overflow-hidden rounded-[var(--radius-lg)] border text-left outline-none transition-all active:cursor-grabbing ${
        selected
          ? 'border-[var(--accent)]/45 bg-[var(--accent-light)] shadow-[0_0_0_1px_var(--accent)]/20'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]/25 hover:bg-[var(--bg-secondary)] focus-visible:border-[var(--accent)]/40'
      }`}
    >
      <div
        className={`w-[3px] flex-shrink-0 ${
          task.status === 'running'
            ? 'bg-cyan-400'
            : task.status === 'needs_review'
              ? 'bg-amber-400'
              : task.status === 'done'
                ? 'bg-green-400'
                : task.status === 'cancelled'
                  ? 'bg-gray-300 dark:bg-gray-600'
                  : 'bg-blue-400'
        }`}
      />
      <div className="min-w-0 flex-1 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {task.title}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
              {latestRun ? (
                <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                  <RuntimeLogo provider={latestRun.provider} className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">
                    {getProviderLabel(latestRun.provider)}
                    {getShortModelLabel(latestRun.model) ? ` ${getShortModelLabel(latestRun.model)}` : ''}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-muted)]">
                  No runs
                </span>
              )}
              {latestRun ? <span className={`flex-shrink-0 font-medium ${runStatusClass}`}>{RUN_STATUS_LABELS[status]}</span> : null}
            </div>
          </div>
          <span className="flex-shrink-0 text-[10px] text-[var(--text-muted)]">
            {formatRelativeTimestamp(getTaskUpdatedAt(task, latestRun ? [latestRun] : []))}
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <FolderOpen className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{getProjectLabel(task.cwd)}</span>
        </div>

        {(task.description || latestSession) ? (
          <div className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-[var(--text-secondary)]">
            {task.description ? truncate(task.description, 150) : getLatestActivitySummary(latestSession)}
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px]">
            <Layers3 className="h-3 w-3" />
            {runCount} run{runCount === 1 ? '' : 's'}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px]">
            <FileDiff className="h-3 w-3" />
            {changeSummary.files} files
          </span>
          {latestRun?.status === 'waiting_permission' ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-[1px] font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert className="h-3 w-3" />
              Permission
            </span>
          ) : null}
          {latestRun?.testStatus ? (
            <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] font-medium ${TEST_STATUS_COLORS[latestRun.testStatus]}`}>
              <CheckCircle2 className="h-3 w-3" />
              {TEST_STATUS_LABELS[latestRun.testStatus]}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RunRow({
  run,
  session,
  active,
  onSelect,
}: {
  run: AgentRun;
  session?: SessionView;
  active: boolean;
  onSelect: () => void;
}) {
  const duration =
    run.completedAt && run.completedAt > run.startedAt
      ? `${Math.max(1, Math.round((run.completedAt - run.startedAt) / 1000))}s`
      : formatRelativeTimestamp(run.startedAt);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-[var(--radius-lg)] border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-[var(--accent)]/40 bg-[var(--accent-light)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <RuntimeLogo provider={run.provider} className="h-3.5 w-3.5" />
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {getProviderLabel(run.provider)}
            {getShortModelLabel(run.model) ? ` ${getShortModelLabel(run.model)}` : ''}
          </div>
        </div>
        <span className={`text-[11px] font-medium ${RUN_STATUS_COLORS[run.status]}`}>
          {RUN_STATUS_LABELS[run.status]}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)]">
        <span>{duration}</span>
        <span>{run.workspaceMode === 'isolated' ? 'Isolated' : 'Current cwd'}</span>
      </div>
      {run.workspaceBranch || run.validationCommand ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-[var(--text-muted)]">
          {run.workspaceBranch ? <span className="truncate">Branch: {run.workspaceBranch}</span> : null}
          {run.validationCommand ? <span className="truncate">Validate: {run.validationCommand}</span> : null}
        </div>
      ) : null}
      <div className="mt-1 line-clamp-2 text-[11px] leading-[17px] text-[var(--text-secondary)]">
        {run.lastEventSummary || getLatestActivitySummary(session)}
      </div>
    </button>
  );
}

function EmptyState({ onNewRun }: { onNewRun: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
          <KanbanSquare className="h-5 w-5" />
        </div>
        <div className="mt-3 text-[14px] font-semibold text-[var(--text-primary)]">No tasks yet</div>
        <div className="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">
          Start by creating a local task and running an agent against it. Board tasks stay local unless you link an external issue later.
        </div>
        <button
          type="button"
          onClick={onNewRun}
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>
    </div>
  );
}

export function BoardView() {
  const {
    tasks,
    agentRuns,
    sessions,
    pendingStart,
    projectCwd,
    setActiveSession,
    setActiveWorkspace,
    setPendingStart,
    setShowNewSession,
  } = useAppStore();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [detailTab, setDetailTab] = useState<DetailTab>('runs');
  const [searchQuery, setSearchQuery] = useState('');
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runDialogMode, setRunDialogMode] = useState<RunDialogMode>('new-task');
  const [dialogTaskId, setDialogTaskId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [runPrompt, setRunPrompt] = useState('');
  const [runProvider, setRunProvider] = useState<AgentProvider>('claude');
  const [runCwd, setRunCwd] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<'current_cwd' | 'isolated'>('isolated');

  const taskList = useMemo(() => Object.values(tasks), [tasks]);
  const runList = useMemo(() => Object.values(agentRuns), [agentRuns]);

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const list = !query
      ? taskList
      : taskList.filter((task) => (
          task.title.toLowerCase().includes(query) ||
          task.description?.toLowerCase().includes(query) ||
          task.cwd?.toLowerCase().includes(query) ||
          task.labels.some((label) => label.toLowerCase().includes(query))
        ));

    return list.sort((left, right) => getTaskUpdatedAt(right, runList) - getTaskUpdatedAt(left, runList));
  }, [runList, searchQuery, taskList]);

  const selectedTask = selectedTaskId ? tasks[selectedTaskId] || null : null;
  const selectedTaskRuns = useMemo(
    () => selectedTask ? getRunsForTask(selectedTask.id, runList) : [],
    [runList, selectedTask]
  );
  const latestSelectedRun = selectedTask ? getLatestRun(selectedTask.id, runList) : null;
  const explicitSelectedRun = selectedRunId
    ? selectedTaskRuns.find((run) => run.id === selectedRunId) || null
    : null;
  const selectedRun = explicitSelectedRun || latestSelectedRun || null;
  const selectedSession = selectedRun ? sessions[selectedRun.sessionId] : undefined;
  const selectedChangeSummary = getChangeSummary(selectedSession);

  const projectOptions = useMemo(() => {
    const unique = new Set<string>();
    if (projectCwd?.trim()) unique.add(projectCwd.trim());
    for (const task of taskList) {
      if (task.cwd?.trim()) unique.add(task.cwd.trim());
    }
    for (const session of Object.values(sessions)) {
      if (session.cwd?.trim()) unique.add(session.cwd.trim());
    }
    return Array.from(unique.values()).sort((left, right) => left.localeCompare(right));
  }, [projectCwd, sessions, taskList]);

  useEffect(() => {
    if (!selectedTaskId || !filteredTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0]?.id || null);
    }
  }, [filteredTasks, selectedTaskId]);

  useEffect(() => {
    if (!selectedTask) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !selectedTaskRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(selectedTaskRuns[0]?.id || null);
    }
  }, [selectedRunId, selectedTask, selectedTaskRuns]);

  useEffect(() => {
    if (!runDialogOpen) return;
    if (!runCwd && projectOptions.length > 0) {
      setRunCwd(projectOptions[0]);
    }
  }, [projectOptions, runCwd, runDialogOpen]);

  useEffect(() => {
    if (!selectedSession || selectedSession.hydrated) return;
    sendEvent({ type: 'session.history', payload: { sessionId: selectedSession.id } });
  }, [selectedSession]);

  const openNewTaskDialog = useCallback(() => {
    setRunDialogMode('new-task');
    setDialogTaskId(null);
    setTaskTitle('');
    setTaskDescription('');
    setRunPrompt('');
    setRunCwd(projectCwd || projectOptions[0] || '');
    setWorkspaceMode('isolated');
    setRunDialogOpen(true);
  }, [projectCwd, projectOptions]);

  const openExistingTaskRunDialog = useCallback((task: BoardTask) => {
    setRunDialogMode('existing-task');
    setDialogTaskId(task.id);
    setTaskTitle(task.title);
    setTaskDescription(task.description || '');
    setRunPrompt('');
    setRunCwd(task.cwd || projectCwd || projectOptions[0] || '');
    setWorkspaceMode('isolated');
    setRunDialogOpen(true);
  }, [projectCwd, projectOptions]);

  const handleCreateTaskOnly = () => {
    const title = taskTitle.trim();
    if (!title) {
      toast.error('Enter a task title.');
      return;
    }

    sendEvent({
      type: 'task.create',
      payload: {
        title,
        description: taskDescription.trim() || undefined,
        cwd: runCwd.trim() || undefined,
        source: 'local',
      },
    });
    setRunDialogOpen(false);
  };

  const handleStartRun = () => {
    const prompt = runPrompt.trim();
    const cwd = runCwd.trim();
    if (!prompt) {
      toast.error('Enter a prompt to start a run.');
      return;
    }
    if (!cwd) {
      toast.error('Select a project folder before starting a run.');
      return;
    }
    if (runDialogMode === 'new-task' && !taskTitle.trim()) {
      toast.error('Enter a task title.');
      return;
    }

    setPendingStart(true);
    sendEvent({
      type: 'task.startRun',
      payload: {
        taskId: runDialogMode === 'existing-task' ? dialogTaskId || undefined : undefined,
        taskTitle: runDialogMode === 'new-task' ? taskTitle.trim() : undefined,
        taskDescription: runDialogMode === 'new-task' ? taskDescription.trim() || undefined : undefined,
        prompt,
        cwd,
        provider: runProvider,
        workspaceMode,
      },
    });
    setRunDialogOpen(false);
  };

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    sendEvent({ type: 'task.update', payload: { taskId, updates: { status } } });
  };

  const openThread = (sessionId: string) => {
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setActiveSession(sessionId);
  };

  const columns = useMemo(
    () => TASK_COLUMNS.map((column) => ({
      ...column,
      tasks: filteredTasks.filter((task) => task.status === column.id),
    })),
    [filteredTasks]
  );

  const activeCounts = useMemo(() => {
    const running = runList.filter((run) => run.status === 'running').length;
    const waiting = runList.filter((run) => run.status === 'waiting_permission').length;
    const review = taskList.filter((task) => task.status === 'needs_review').length;
    const failed = runList.filter((run) => run.status === 'failed').length;
    return { running, waiting, review, failed };
  }, [runList, taskList]);

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

            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1">
                <PlayCircle className="h-3 w-3 text-blue-500" />
                {activeCounts.running} running
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1">
                <ShieldAlert className="h-3 w-3 text-amber-500" />
                {activeCounts.waiting} waiting
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {activeCounts.review} review
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-1">
                <XCircle className="h-3 w-3 text-red-500" />
                {activeCounts.failed} failed
              </span>
            </div>

            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter tasks..."
              className="h-8 w-[180px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />

            <div className="ml-auto">
              <button
                type="button"
                onClick={openNewTaskDialog}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--accent)]/20 bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                <Plus className="h-3.5 w-3.5" />
                New Task
              </button>
            </div>
          </div>

          {taskList.length === 0 ? (
            <EmptyState onNewRun={openNewTaskDialog} />
          ) : (
            <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 py-4">
              <div className="flex h-full gap-3">
                {columns.map((column) => (
                  <div
                    key={column.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverStatus(column.id);
                    }}
                    onDragLeave={() => {
                      setDragOverStatus((current) => (current === column.id ? null : current));
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const taskId = event.dataTransfer.getData('text/plain') || draggingTaskId;
                      if (taskId) updateTaskStatus(taskId, column.id);
                      setDraggingTaskId(null);
                      setDragOverStatus(null);
                    }}
                    className={`flex h-full min-w-[260px] flex-1 flex-col overflow-hidden rounded-[var(--radius-xl)] border bg-[var(--bg-secondary)] transition-colors ${
                      dragOverStatus === column.id
                        ? 'border-[var(--accent)]/45 bg-[var(--accent-light)]/20'
                        : 'border-[var(--border)]'
                    }`}
                  >
                    <div className={`h-[3px] flex-shrink-0 rounded-t-[var(--radius-xl)] ${column.accent}`} />
                    <div className="border-b border-[var(--border)] px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-semibold text-[var(--text-primary)]">{column.label}</div>
                          <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{column.description}</div>
                        </div>
                        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[11px] font-semibold text-[var(--text-muted)]">
                          {column.tasks.length}
                        </span>
                      </div>
                    </div>

                    <div className="board-column-scroll min-h-0 flex-1 overflow-y-auto p-2">
                      {column.tasks.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-[12px] text-[var(--text-muted)]">
                          <span className="border-b border-dashed border-[var(--border)]">No tasks</span>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {column.tasks.map((task) => {
                            const latestRun = getLatestRun(task.id, runList);
                            const taskRuns = getRunsForTask(task.id, runList);
                            const latestSession = latestRun ? sessions[latestRun.sessionId] : undefined;
                            return (
                              <TaskCard
                                key={task.id}
                                task={task}
                                latestRun={latestRun}
                                latestSession={latestSession}
                                runCount={taskRuns.length}
                                selected={selectedTaskId === task.id}
                                onSelect={() => {
                                  setSelectedTaskId(task.id);
                                  setDetailOpen(true);
                                }}
                                onDragStart={() => setDraggingTaskId(task.id)}
                                onDragEnd={() => {
                                  setDraggingTaskId(null);
                                  setDragOverStatus(null);
                                }}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {detailOpen ? (
          <aside className="flex w-[380px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-[12px] font-semibold text-[var(--text-secondary)]">Task Details</span>
              <button
                type="button"
                onClick={() => setDetailOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title="Collapse panel"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </div>

            {!selectedTask ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
                Select a task to inspect
              </div>
            ) : (
              <>
                <div className="board-column-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <div>
                    <div className="text-[14px] font-semibold leading-tight text-[var(--text-primary)]">
                      {selectedTask.title}
                    </div>
                    {selectedTask.description ? (
                      <div className="mt-1.5 text-[12px] leading-5 text-[var(--text-secondary)]">
                        {selectedTask.description}
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span className="inline-flex items-center rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                        {TASK_LABELS[selectedTask.status]}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                        <FolderOpen className="h-3 w-3" />
                        {getProjectLabel(selectedTask.cwd)}
                      </span>
                      {selectedTask.externalUrl ? (
                        <span className="inline-flex items-center rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[var(--text-secondary)]">
                          Linked
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openExistingTaskRunDialog(selectedTask)}
                      className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[12px] font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Run Agent
                    </button>
                    {selectedRun ? (
                      <button
                        type="button"
                        onClick={() => openThread(selectedRun.sessionId)}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        Thread
                      </button>
                    ) : null}
                  </div>

                  {selectedTask.status === 'needs_review' && selectedRun?.status === 'completed' ? (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => sendEvent({ type: 'task.acceptRun', payload: { taskId: selectedTask.id, runId: selectedRun.id } })}
                        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-green-500/25 bg-green-500/10 text-[12px] font-medium text-green-600 transition-colors hover:bg-green-500/15 dark:text-green-400"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => sendEvent({ type: 'task.rejectRun', payload: { taskId: selectedTask.id, runId: selectedRun.id } })}
                        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-red-500/20 bg-red-500/10 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-500/15 dark:text-red-400"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-3 border-b border-[var(--border)]">
                    <div className="flex gap-1">
                      {(['runs', 'activity', 'changes', 'artifacts'] as DetailTab[]).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setDetailTab(tab)}
                          className={`border-b-2 px-2.5 py-2 text-[11px] font-medium capitalize transition-colors ${
                            detailTab === tab
                              ? 'border-[var(--accent)] text-[var(--text-primary)]'
                              : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                          }`}
                        >
                          {tab}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="py-3">
                    {detailTab === 'runs' ? (
                      <div className="space-y-2">
                        {selectedTaskRuns.length === 0 ? (
                          <div className="text-[12px] text-[var(--text-muted)]">No runs yet.</div>
                        ) : selectedTaskRuns.map((run) => (
                          <RunRow
                            key={run.id}
                            run={run}
                            session={sessions[run.sessionId]}
                            active={selectedRun?.id === run.id}
                            onSelect={() => setSelectedRunId(run.id)}
                          />
                        ))}
                      </div>
                    ) : null}

                    {detailTab === 'activity' ? (
                      <div className="space-y-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Latest Summary</div>
                          <div className="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">
                            {getLatestActivitySummary(selectedSession)}
                          </div>
                        </div>
                        {selectedSession?.permissionRequests.length ? (
                          <div className="rounded-[var(--radius-lg)] border border-amber-400/25 bg-amber-400/10 p-3 text-[12px] text-amber-700 dark:text-amber-300">
                            Waiting for {selectedSession.permissionRequests.length} permission request{selectedSession.permissionRequests.length === 1 ? '' : 's'}.
                          </div>
                        ) : null}
                        <div className="text-[11px] text-[var(--text-muted)]">
                          Use Open Thread for the full transcript.
                        </div>
                      </div>
                    ) : null}

                    {detailTab === 'changes' ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-2">
                            <div className="text-[16px] font-semibold text-[var(--text-primary)]">{selectedChangeSummary.files}</div>
                            <div className="text-[10px] text-[var(--text-muted)]">files</div>
                          </div>
                          <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-2">
                            <div className="text-[16px] font-semibold text-green-600 dark:text-green-400">+{selectedChangeSummary.added}</div>
                            <div className="text-[10px] text-[var(--text-muted)]">added</div>
                          </div>
                          <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-2">
                            <div className="text-[16px] font-semibold text-red-600 dark:text-red-400">-{selectedChangeSummary.removed}</div>
                            <div className="text-[10px] text-[var(--text-muted)]">removed</div>
                          </div>
                        </div>
                        {selectedRun?.testStatus ? (
                          <div className={`rounded-[var(--radius-lg)] border p-3 text-[12px] leading-5 ${TEST_STATUS_COLORS[selectedRun.testStatus]}`}>
                            <div className="font-medium">{TEST_STATUS_LABELS[selectedRun.testStatus]}</div>
                            {selectedRun.validationCommand ? (
                              <div className="mt-1 font-mono text-[11px]">{selectedRun.validationCommand}</div>
                            ) : null}
                            {selectedRun.lastEventSummary ? (
                              <div className="mt-1">{selectedRun.lastEventSummary}</div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="text-[12px] leading-5 text-[var(--text-secondary)]">
                          Detailed diffs remain available in the thread and project Changes panel. This board keeps the review checkpoint visible.
                        </div>
                      </div>
                    ) : null}

                    {detailTab === 'artifacts' ? (
                      <div className="space-y-2 text-[12px] leading-5 text-[var(--text-secondary)]">
                        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                          Generated artifacts stay attached to the backing session and project files. Open the thread to inspect rich previews.
                        </div>
                        {selectedRun?.workspacePath ? (
                          <div className="truncate text-[11px] text-[var(--text-muted)]" title={selectedRun.workspacePath}>
                            Workspace: {selectedRun.workspacePath}
                          </div>
                        ) : null}
                        {selectedRun?.workspaceBranch ? (
                          <div className="truncate text-[11px] text-[var(--text-muted)]" title={selectedRun.workspaceBranch}>
                            Branch: {selectedRun.workspaceBranch}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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

      {runDialogOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-2xl rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
              <div>
                <div className="text-base font-semibold text-[var(--text-primary)]">
                  {runDialogMode === 'new-task' ? 'New Task' : 'Run Agent'}
                </div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  {runDialogMode === 'new-task'
                    ? 'Create a local task and optionally start an agent run.'
                    : `Start another run for "${taskTitle}".`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRunDialogOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              {runDialogMode === 'new-task' ? (
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Task Title</div>
                    <input
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="Fix flaky settings save"
                      className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                    />
                  </label>

                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Runtime</div>
                    <select
                      value={runProvider}
                      onChange={(event) => setRunProvider(event.target.value as AgentProvider)}
                      className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none"
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                  <div>
                    <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Task</div>
                    <div className="flex h-11 items-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-secondary)]">
                      <span className="truncate">{taskTitle}</span>
                    </div>
                  </div>
                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Runtime</div>
                    <select
                      value={runProvider}
                      onChange={(event) => setRunProvider(event.target.value as AgentProvider)}
                      className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none"
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </label>
                </div>
              )}

              <label className="block">
                <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Project</div>
                <input
                  list="board-project-options"
                  value={runCwd}
                  onChange={(event) => setRunCwd(event.target.value)}
                  placeholder="Select or paste a project path"
                  className="h-11 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
                <datalist id="board-project-options">
                  {projectOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </label>

              {runDialogMode === 'new-task' ? (
                <label className="block">
                  <div className="mb-2 text-sm font-medium text-[var(--text-primary)]">Task Notes</div>
                  <textarea
                    value={taskDescription}
                    onChange={(event) => setTaskDescription(event.target.value)}
                    placeholder="Acceptance criteria, context, or constraints..."
                    className="min-h-[72px] w-full resize-y rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                  />
                </label>
              ) : null}

              <label className="block">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-[var(--text-primary)]">Run Prompt</span>
                  <select
                    value={workspaceMode}
                    onChange={(event) => setWorkspaceMode(event.target.value as typeof workspaceMode)}
                    className="h-8 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[12px] text-[var(--text-primary)] outline-none"
                  >
                    <option value="isolated">Isolated worktree</option>
                    <option value="current_cwd">Current cwd</option>
                  </select>
                </div>
                <textarea
                  value={runPrompt}
                  onChange={(event) => setRunPrompt(event.target.value)}
                  placeholder="Describe what the agent should do..."
                  className="min-h-[150px] w-full resize-y rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4">
              <div className="text-[11px] text-[var(--text-muted)]">
                Completed runs move to Needs Review before Done.
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setRunDialogOpen(false)}
                  className="inline-flex h-10 items-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
                {runDialogMode === 'new-task' ? (
                  <button
                    type="button"
                    onClick={handleCreateTaskOnly}
                    disabled={!taskTitle.trim()}
                    className="inline-flex h-10 items-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Create Only
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleStartRun}
                  disabled={pendingStart || !runPrompt.trim() || !runCwd.trim() || (runDialogMode === 'new-task' && !taskTitle.trim())}
                  className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-xl)] bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Sparkles className="h-4 w-4" />
                  {pendingStart ? 'Starting...' : 'Start Run'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
