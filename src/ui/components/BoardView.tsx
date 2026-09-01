import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { toast } from 'sonner';
import { Check, ChevronDown, Folder, FolderOpen, Loader2, Play, Plus, Search, X } from './icons';
import { SidebarHeaderTrigger } from './Sidebar';
import { SessionHistoryButtons } from './SessionHistoryButtons';
import { AgentIcon, ComposerAgentModelPicker } from './ComposerAgentControls';
import { BoardTaskDetail } from './BoardTaskDetail';
import { useAppStore } from '../store/useAppStore';
import { useComposerAgentSelection } from '../hooks/useComposerAgentSelection';
import {
  BOARD_STAGES,
  ensureBoardSessionSync,
  latestTaskSession,
  sessionIdsOnBoard,
  useBoardStore,
  type BoardSessionConfig,
  type BoardStage,
  type BoardTask,
} from '../store/useBoardStore';
import {
  STAGE_META,
  RunBadge,
  StageIcon,
  deriveRunState,
  modelDisplayLabel,
  projectName,
  providerLabel,
  relativeTime,
  titleFromPrompt,
} from './board-support';
import type { SessionView } from '../types';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';

export function BoardView() {
  const sessions = useAppStore((state) => state.sessions);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const currentProjectCwd = useAppStore((state) => state.projectCwd);
  const activeChannelByProject = useAppStore((state) => state.activeChannelByProject);
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const setActiveSession = useAppStore((state) => state.setActiveSession);
  const setShowNewSession = useAppStore((state) => state.setShowNewSession);

  const tasks = useBoardStore((state) => state.tasks);
  const addTask = useBoardStore((state) => state.addTask);
  const updateTask = useBoardStore((state) => state.updateTask);
  const setStage = useBoardStore((state) => state.setStage);
  const renameTask = useBoardStore((state) => state.renameTask);
  const attachSession = useBoardStore((state) => state.attachSession);
  const removeTask = useBoardStore((state) => state.removeTask);
  const markSeen = useBoardStore((state) => state.markSeen);

  const [projectFilter, setProjectFilter] = useState<string | 'all'>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [composerTaskId, setComposerTaskId] = useState<string | null | undefined>(undefined);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [dragOverStage, setDragOverStage] = useState<BoardStage | null>(null);
  // Card right-click menu — Edit/Remove live here, not in the detail page.
  const [cardMenu, setCardMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cardMenu) return;
    const close = () => setCardMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [cardMenu]);

  useEffect(() => {
    ensureBoardSessionSync();
    void window.electron.getRecentCwds(12).then(setRecentCwds).catch(() => undefined);
  }, []);

  const taskList = useMemo(
    () => Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks]
  );

  // Filter chips: All + every project that has at least one card. `null`
  // (no project) renders as its own chip keyed by the empty string.
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of taskList) {
      const key = task.projectCwd || '';
      if (!seen.has(key)) seen.set(key, projectName(task.projectCwd));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [taskList]);

  const composerProjectOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            currentProjectCwd,
            projectFilter !== 'all' && projectFilter ? projectFilter : null,
            ...recentCwds,
            ...Object.values(sessions).flatMap((session) => [session.projectCwd, session.cwd]),
            ...taskList.map((task) => task.projectCwd),
          ].filter((cwd): cwd is string => Boolean(cwd?.trim()))
        )
      ),
    [currentProjectCwd, projectFilter, recentCwds, sessions, taskList]
  );

  const visibleTasks = useMemo(
    () =>
      projectFilter === 'all'
        ? taskList
        : taskList.filter((task) => (task.projectCwd || '') === projectFilter),
    [taskList, projectFilter]
  );

  const byStage = useMemo(() => {
    const groups: Record<BoardStage, BoardTask[]> = { inbox: [], working: [], review: [], done: [] };
    for (const task of visibleTasks) groups[task.stage].push(task);
    return groups;
  }, [visibleTasks]);

  const workingCount = useMemo(
    () =>
      visibleTasks.filter((task) => {
        const state = deriveRunState(task, latestTaskSession(task, sessions));
        return state === 'working' || state === 'permission';
      }).length,
    [visibleTasks, sessions]
  );
  const reviewCount = byStage.review.length;

  const selectedTask = selectedTaskId ? tasks[selectedTaskId] ?? null : null;

  const openSession = (sessionId: string) => {
    setActiveWorkspace('chat');
    setActiveSession(sessionId);
    setShowNewSession(false);
  };

  const openTask = (task: BoardTask) => {
    setSelectedTaskId(task.id);
    markSeen(task.id);
  };

  const startTask = async (task: BoardTask): Promise<void> => {
    if (!task.prompt.trim() || !task.projectCwd) {
      setComposerTaskId(task.id);
      return;
    }

    const result = await window.electron.startBackgroundSession({
      title: task.title,
      prompt: task.prompt,
      cwd: task.projectCwd,
      projectCwd: task.projectCwd,
      scope: 'project',
      channelId: activeChannelByProject[task.projectCwd] || DEFAULT_WORKSPACE_CHANNEL_ID,
      ...task.sessionConfig,
    });
    if (result.sessionId) {
      attachSession(task.id, result.sessionId);
      setStage(task.id, 'working');
    }
    if (!result.ok) {
      // The session row may have been created before a runtime readiness
      // check failed. Refresh once so the card derives the persisted error
      // state instead of keeping the optimistic initial `running` snapshot.
      window.electron.sendClientEvent({ type: 'session.list' });
      toast.error(
        result.sessionId
          ? 'The session was created, but the selected agent could not start.'
          : 'Could not create the task session.'
      );
    }
  };

  // Send a follow-up prompt to the task's latest run without leaving the
  // board. Review/Done cards move back to Working — the agent is on it again.
  const continueTask = (task: BoardTask, prompt: string): boolean => {
    const latest = latestTaskSession(task, sessions);
    if (!latest) {
      toast.error('This task has no session to continue.');
      return false;
    }
    window.electron.sendClientEvent({
      type: 'session.continue',
      payload: { sessionId: latest.id, prompt },
    });
    if (task.stage === 'review' || task.stage === 'done') setStage(task.id, 'working');
    return true;
  };

  const handleDrop = (event: DragEvent, stage: BoardStage) => {
    event.preventDefault();
    setDragOverStage(null);
    const taskId = event.dataTransfer.getData('text/board-task');
    if (taskId && tasks[taskId]) setStage(taskId, stage);
  };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
      <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0`}>
        <div className="flex h-full items-center px-3">
          {sidebarCollapsed ? (
            <>
              <SidebarHeaderTrigger className="ml-[72px]" />
              <SessionHistoryButtons />
            </>
          ) : null}
        </div>
      </div>

      {selectedTask ? (
        <BoardTaskDetail
          task={selectedTask}
          sessions={sessions}
          orderedTaskIds={visibleTasks.map((task) => task.id)}
          onBack={() => setSelectedTaskId(null)}
          onSelectTask={(taskId) => {
            setSelectedTaskId(taskId);
            markSeen(taskId);
          }}
          onOpenSession={openSession}
          onSetStage={(stage) => setStage(selectedTask.id, stage)}
          onRename={(title) => renameTask(selectedTask.id, title)}
          onUpdatePrompt={(prompt) => updateTask(selectedTask.id, { prompt })}
          onStart={() => void startTask(selectedTask)}
          onContinue={(prompt) => continueTask(selectedTask, prompt)}
          onEdit={() => setComposerTaskId(selectedTask.id)}
        />
      ) : (
        <>
      <div className="flex flex-shrink-0 items-center justify-between gap-3 px-5 pb-3 pt-1">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            Board
          </h1>
          <span className="truncate text-[12px] text-[var(--text-muted)]">
            {workingCount} agent{workingCount === 1 ? '' : 's'} working · {reviewCount} waiting for
            review
          </span>
        </div>

        <div className="no-drag relative flex items-center gap-1.5">
          <ProjectFilterMenu
            projectFilter={projectFilter}
            projectOptions={projectOptions}
            totalCount={taskList.length}
            countFor={(key) => taskList.filter((task) => (task.projectCwd || '') === key).length}
            onSelect={setProjectFilter}
          />
          <button
            type="button"
            onClick={() => setComposerTaskId(null)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-85"
          >
            <Plus className="h-3.5 w-3.5" />
            New Task
          </button>
          <button
            type="button"
            onClick={() => setAddOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[var(--composer-chip-border)] bg-[var(--preview-surface)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Add Session
          </button>
          {addOpen ? (
            <AddToBoardPopover
              sessions={sessions}
              tasks={tasks}
              onClose={() => setAddOpen(false)}
              onAddSession={(session) => {
                const stage: BoardStage =
                  session.status === 'running' || session.status === 'stopping'
                    ? 'working'
                    : session.status === 'completed'
                      ? 'review'
                      : 'inbox';
                addTask({
                  title: session.title || 'Untitled task',
                  projectCwd: session.projectCwd || session.cwd || null,
                  sessionConfig: {
                    provider: session.provider,
                    model: session.model,
                    compatibleProviderId: session.compatibleProviderId,
                    claudeAccessMode: session.claudeAccessMode,
                    claudeExecutionMode: session.claudeExecutionMode,
                    claudeReasoningEffort: session.claudeReasoningEffort,
                    codexExecutionMode: session.codexExecutionMode,
                    codexPermissionMode: session.codexPermissionMode,
                    codexReasoningEffort: session.codexReasoningEffort,
                    codexFastMode: session.codexFastMode,
                    kimiPermissionMode: session.kimiPermissionMode,
                    grokPermissionMode: session.grokPermissionMode,
                    grokReasoningEffort: session.grokReasoningEffort,
                    deepseekAgentPreset: session.deepseekAgentPreset,
                    opencodePermissionMode: session.opencodePermissionMode,
                    bubblePermissionMode: session.bubblePermissionMode,
                  },
                  sessionId: session.id,
                  stage,
                });
                setAddOpen(false);
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-5">
        {BOARD_STAGES.map((stage) => {
          const meta = STAGE_META[stage];
          const stageTasks = byStage[stage];
          return (
            <section
              key={stage}
              className={`flex min-h-0 min-w-[250px] max-w-[340px] flex-1 flex-col rounded-xl bg-[var(--bg-secondary)] transition-colors ${
                dragOverStage === stage ? 'bg-[var(--sidebar-item-active)]' : ''
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverStage(stage);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setDragOverStage(null);
                }
              }}
              onDrop={(event) => handleDrop(event, stage)}
            >
              <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-2 pt-3">
                <StageIcon stage={stage} className="h-3.5 w-3.5" />
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {meta.label}
                </span>
                <span className="text-[12px] text-[var(--text-muted)]">{stageTasks.length}</span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {stageTasks.length === 0 ? (
                  <div className="rounded-[10px] border border-dashed border-[var(--composer-chip-border)] px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
                    No tasks
                  </div>
                ) : (
                  stageTasks.map((task) => (
                    <BoardCard
                      key={task.id}
                      task={task}
                      session={latestTaskSession(task, sessions)}
                      selected={task.id === selectedTaskId}
                      showProject={projectFilter === 'all'}
                      onClick={() => openTask(task)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setCardMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
                      }}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
        </>
      )}

      {cardMenu && tasks[cardMenu.taskId] ? (
        <div
          className="fixed z-50 w-[180px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] py-1 shadow-lg"
          style={{ left: cardMenu.x, top: cardMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setComposerTaskId(cardMenu.taskId);
              setCardMenu(null);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          >
            Edit details
          </button>
          <button
            type="button"
            onClick={() => {
              removeTask(cardMenu.taskId);
              if (selectedTaskId === cardMenu.taskId) setSelectedTaskId(null);
              setCardMenu(null);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--error)]"
          >
            Remove from board
          </button>
        </div>
      ) : null}

      {composerTaskId !== undefined ? (
        <BoardTaskComposer
          task={composerTaskId ? tasks[composerTaskId] || null : null}
          projectOptions={composerProjectOptions}
          initialProjectCwd={
            (projectFilter !== 'all' && projectFilter) || currentProjectCwd || composerProjectOptions[0] || ''
          }
          onClose={() => setComposerTaskId(undefined)}
          onSubmit={async ({ title, prompt, projectCwd, sessionConfig, startNow }) => {
            const taskId = composerTaskId
              ? composerTaskId
              : addTask({ title, prompt, projectCwd, sessionConfig, stage: 'inbox' });
            if (composerTaskId) {
              updateTask(composerTaskId, { title, prompt, projectCwd, sessionConfig });
            }
            setComposerTaskId(undefined);
            setSelectedTaskId(taskId);
            if (startNow) {
              const task = useBoardStore.getState().tasks[taskId];
              if (task) await startTask(task);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Linear-style scope control: the N project chips collapse into one compact
 * dropdown. The button reads as quiet chrome while showing everything, and
 * as an active filter (project name, primary text) once scoped.
 */
function ProjectFilterMenu({
  projectFilter,
  projectOptions,
  totalCount,
  countFor,
  onSelect,
}: {
  projectFilter: string | 'all';
  projectOptions: Array<[string, string]>;
  totalCount: number;
  countFor: (key: string) => number;
  onSelect: (key: string | 'all') => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const filtered = projectFilter !== 'all';
  const activeLabel = filtered
    ? projectOptions.find(([key]) => key === projectFilter)?.[1] || 'Project'
    : 'All Projects';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-[var(--sidebar-item-hover)] ${
          filtered
            ? 'font-medium text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <Folder className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
        <span className="truncate">{activeLabel}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <div className="popover-surface absolute right-0 top-full z-40 mt-1.5 w-[240px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] py-1 shadow-lg">
          <FilterMenuRow
            label="All Projects"
            count={totalCount}
            selected={!filtered}
            onClick={() => {
              onSelect('all');
              setOpen(false);
            }}
          />
          {projectOptions.length > 0 ? (
            <div className="mx-2 my-1 border-t border-[var(--border)]" />
          ) : null}
          {projectOptions.map(([key, label]) => (
            <FilterMenuRow
              key={key || '(none)'}
              label={label}
              count={countFor(key)}
              selected={projectFilter === key}
              onClick={() => {
                onSelect(key);
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterMenuRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--sidebar-item-hover)] ${
        selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">{count}</span>
      {selected ? <Check className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" /> : null}
    </button>
  );
}

function BoardCard({
  task,
  session,
  selected,
  showProject,
  onClick,
  onContextMenu,
}: {
  task: BoardTask;
  session: SessionView | null;
  selected: boolean;
  /** Only when the board mixes projects — a scoped board would repeat it on every card. */
  showProject: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const runState = deriveRunState(task, session);
  const provider = session?.provider || task.sessionConfig.provider;
  const label =
    modelDisplayLabel(provider, session?.model || task.sessionConfig.model) ||
    providerLabel(provider);
  return (
    <button
      type="button"
      draggable
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/board-task', task.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      className={`relative w-full rounded-[10px] border bg-[var(--preview-surface)] px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(15,18,25,0.04)] transition-[box-shadow,transform,border-color,opacity] duration-150 hover:-translate-y-px hover:shadow-[0_2px_6px_rgba(15,18,25,0.06),0_16px_40px_-12px_rgba(15,18,25,0.18)] ${
        selected ? 'border-[var(--border-focus)]' : 'border-[var(--border)]'
      } ${task.stage === 'done' ? 'opacity-60 hover:opacity-100' : ''}`}
    >
      {task.unread ? (
        <span className="absolute right-3 top-3 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
      ) : null}
      <div className="flex items-start gap-1.5 pr-4">
        <StageIcon stage={task.stage} className="mt-[2.5px] h-3.5 w-3.5" />
        <span className="min-w-0 text-[13px] font-medium leading-snug text-[var(--text-primary)]">
          {task.title}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {showProject ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Folder className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">{projectName(task.projectCwd)}</span>
          </span>
        ) : null}
        {provider ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <AgentIcon provider={provider} />
            {label}
          </span>
        ) : null}
        {task.sessionIds.length > 1 ? (
          <span className="text-[11px] text-[var(--text-muted)]">
            {task.sessionIds.length} runs
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex min-h-[16px] items-center gap-2">
        {/* The column already says "Review" — only live runtime states earn a badge. */}
        {runState && runState !== 'ready' ? <RunBadge state={runState} /> : null}
        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
          {relativeTime(task.updatedAt)}
        </span>
      </div>
    </button>
  );
}

function AddToBoardPopover({
  sessions,
  tasks,
  onClose,
  onAddSession,
}: {
  sessions: Record<string, SessionView>;
  tasks: Record<string, BoardTask>;
  onClose: () => void;
  onAddSession: (session: SessionView) => void;
}) {
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const linked = useMemo(() => sessionIdsOnBoard(tasks), [tasks]);
  const candidates = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return Object.values(sessions)
      .filter(
        (session) =>
          !session.isDraft &&
          !session.hiddenFromThreads &&
          !linked.has(session.id) &&
          (session.title || '').trim().length > 0 &&
          (!trimmed || session.title.toLowerCase().includes(trimmed))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);
  }, [sessions, linked, query]);

  return (
    <div
      ref={containerRef}
      className="popover-surface absolute right-0 top-full z-40 mt-1.5 w-[340px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5 text-[var(--text-muted)]">
        <Search className="h-3.5 w-3.5 flex-shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions…"
          className="w-full bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>
      <div className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
        Recent sessions not on the board
      </div>
      <div className="max-h-[280px] overflow-y-auto pb-1.5">
        {candidates.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
            No matching sessions
          </div>
        ) : (
          candidates.map((session) => {
            const destination =
              session.status === 'running' || session.status === 'stopping'
                ? 'Working'
                : session.status === 'completed'
                  ? 'Review'
                  : 'Inbox';
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onAddSession(session)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--sidebar-item-hover)]"
              >
                {session.status === 'running' || session.status === 'stopping' ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-[var(--text-muted)]" />
                ) : (
                  <span
                    className={`status-dot flex-shrink-0 ${
                      session.status === 'completed'
                        ? 'completed'
                        : session.status === 'error'
                          ? 'error'
                          : 'idle'
                    }`}
                    style={{ width: 6, height: 6 }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">
                  {session.title}
                </span>
                <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                  {projectName(session.projectCwd || session.cwd || null)}
                </span>
                <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                  → {destination}
                </span>
              </button>
            );
          })
        )}
      </div>
      <p className="border-t border-[var(--border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        A session joins the column that matches its state — running goes to Working, finished to
        Review.
      </p>
    </div>
  );
}

function BoardTaskComposer({
  task,
  projectOptions,
  initialProjectCwd,
  onClose,
  onSubmit,
}: {
  task: BoardTask | null;
  projectOptions: string[];
  initialProjectCwd: string;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    prompt: string;
    projectCwd: string | null;
    sessionConfig: Partial<BoardSessionConfig>;
    startNow: boolean;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title === 'Untitled task' ? '' : task?.title || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [projectCwd, setProjectCwd] = useState(task?.projectCwd || initialProjectCwd);
  const [submitting, setSubmitting] = useState(false);
  const agentSelection = useComposerAgentSelection({
    selectionKey: task?.id || '__board_new_task__',
    provider: task?.sessionConfig.provider || null,
    model: task?.sessionConfig.model || null,
    compatibleProviderId: task?.sessionConfig.compatibleProviderId || null,
    claudePermissionMode: task?.sessionConfig.claudeAccessMode || null,
    claudeExecutionMode: task?.sessionConfig.claudeExecutionMode || null,
    codexExecutionMode: task?.sessionConfig.codexExecutionMode || null,
    codexPermissionMode: task?.sessionConfig.codexPermissionMode || null,
    opencodePermissionMode: task?.sessionConfig.opencodePermissionMode || null,
    claudeReasoningEffort: task?.sessionConfig.claudeReasoningEffort || null,
    codexReasoningEffort: task?.sessionConfig.codexReasoningEffort || null,
    codexFastMode: task?.sessionConfig.codexFastMode ?? null,
    grokReasoningEffort: task?.sessionConfig.grokReasoningEffort || null,
    bubbleThinkingLevel: task?.sessionConfig.bubbleThinkingLevel || null,
    deepseekAgentPreset: task?.sessionConfig.deepseekAgentPreset || null,
  });

  const buildSessionConfig = (): Partial<BoardSessionConfig> => ({
    provider: agentSelection.provider,
    model: agentSelection.model || undefined,
    compatibleProviderId:
      agentSelection.provider === 'claude'
        ? agentSelection.compatibleProviderId || undefined
        : undefined,
    claudeAccessMode:
      agentSelection.provider === 'claude' ? agentSelection.claudePermissionMode : undefined,
    claudeExecutionMode:
      agentSelection.provider === 'claude' ? agentSelection.claudeExecutionMode : undefined,
    claudeReasoningEffort:
      agentSelection.provider === 'claude'
        ? agentSelection.claudeReasoningEffort || undefined
        : undefined,
    codexExecutionMode:
      agentSelection.provider === 'codex' ? agentSelection.codexExecutionMode : undefined,
    codexPermissionMode:
      agentSelection.provider === 'codex' ? agentSelection.codexPermissionMode : undefined,
    codexReasoningEffort:
      agentSelection.provider === 'codex'
        ? agentSelection.codexReasoningEffort || undefined
        : undefined,
    codexFastMode:
      agentSelection.provider === 'codex' ? agentSelection.codexFastMode : undefined,
    kimiPermissionMode:
      agentSelection.provider === 'kimi' || agentSelection.provider === 'grok'
        ? agentSelection.kimiPermissionMode
        : undefined,
    kimiThinking:
      agentSelection.provider === 'kimi' ? agentSelection.kimiThinkingToSend : undefined,
    grokPermissionMode:
      agentSelection.provider === 'grok' ? agentSelection.kimiPermissionMode : undefined,
    grokReasoningEffort:
      agentSelection.provider === 'grok'
        ? agentSelection.grokReasoningEffort || undefined
        : undefined,
    opencodePermissionMode:
      agentSelection.provider === 'opencode' ? agentSelection.opencodePermissionMode : undefined,
    qoderPermissionMode:
      agentSelection.provider === 'qoder' ? agentSelection.qoderPermissionMode : undefined,
    deepseekPermissionMode:
      agentSelection.provider === 'deepseek' ? agentSelection.deepseekPermissionMode : undefined,
    deepseekAgentPreset:
      agentSelection.provider === 'deepseek' ? agentSelection.deepseekAgentPreset : undefined,
    deepseekReasoningEffort:
      agentSelection.provider === 'deepseek'
        ? agentSelection.deepseekReasoningEffort
        : undefined,
    bubblePermissionMode:
      agentSelection.provider === 'bubble'
        ? agentSelection.bubbleExecutionMode === 'plan'
          ? 'plan'
          : agentSelection.bubblePermissionMode
        : undefined,
    bubbleThinkingLevel:
      agentSelection.provider === 'bubble'
        ? agentSelection.bubbleThinkingLevel || undefined
        : undefined,
  });

  const submit = async (startNow: boolean) => {
    const normalizedPrompt = prompt.trim();
    const normalizedTitle = title.trim() || titleFromPrompt(normalizedPrompt);
    if (!normalizedPrompt && !title.trim()) return;
    if (startNow && !normalizedPrompt) {
      toast.error('Describe the work before starting the task.');
      return;
    }
    if (startNow && !projectCwd.trim()) {
      toast.error('Select a project before starting the task.');
      return;
    }
    if (startNow && agentSelection.modelSetup) {
      toast.error(agentSelection.modelSetup.title);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        title: normalizedTitle,
        prompt: normalizedPrompt,
        projectCwd: projectCwd.trim() || null,
        sessionConfig: buildSessionConfig(),
        startNow,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(640px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_70px_rgba(15,18,25,0.24)]">
          <div className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-[16px] font-semibold text-[var(--text-primary)]">
                {task ? 'Edit task' : 'New task'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                Keep it in Inbox for later, or start an agent without leaving the board.
              </Dialog.Description>
            </div>
            <Dialog.Close className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-[var(--text-secondary)]">
                Task title <span className="font-normal text-[var(--text-muted)]">· optional</span>
              </span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Generated from the first line if left blank"
                className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-[var(--text-secondary)]">
                What should the agent do?
              </span>
              <textarea
                autoFocus
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the outcome, constraints, and how you want it verified…"
                className="min-h-[180px] w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-[var(--text-secondary)]">
                Project
              </span>
              <div className="flex gap-2">
                <select
                  value={projectCwd}
                  onChange={(event) => setProjectCwd(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                >
                  <option value="">No Project</option>
                  {projectCwd && !projectOptions.includes(projectCwd) ? (
                    <option value={projectCwd}>{projectName(projectCwd)} · {projectCwd}</option>
                  ) : null}
                  {projectOptions.map((cwd) => (
                    <option key={cwd} value={cwd}>
                      {projectName(cwd)} · {cwd}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={async () => {
                    const selected = await window.electron.selectDirectory();
                    if (selected) setProjectCwd(selected);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Browse
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3">
            <ComposerAgentModelPicker
              agentProvider={agentSelection.provider}
              modelLabel={agentSelection.selectedModelLabel}
              modelValue={agentSelection.model}
              modelValueByProvider={agentSelection.modelValueByProvider}
              allAgentModelOptions={agentSelection.allAgentModelOptions}
              disabled={submitting}
              onAgentChange={agentSelection.selectAgent}
              onModelChange={agentSelection.selectModel}
              codexModels={agentSelection.codexModels.length > 0 ? agentSelection.codexModels : undefined}
              grokModels={agentSelection.grokModels.length > 0 ? agentSelection.grokModels : undefined}
              bubbleModels={agentSelection.bubbleModels.length > 0 ? agentSelection.bubbleModels : undefined}
              claudeReasoningEffort={agentSelection.claudeReasoningEffort ?? undefined}
              onClaudeReasoningEffortChange={(effort) =>
                agentSelection.selectAgentConfiguration({ provider: 'claude', claudeReasoningEffort: effort })
              }
              codexReasoningEffort={agentSelection.codexReasoningEffort ?? undefined}
              onCodexReasoningEffortChange={(effort) =>
                agentSelection.selectAgentConfiguration({ provider: 'codex', codexReasoningEffort: effort })
              }
              grokReasoningEffort={agentSelection.grokReasoningEffort ?? undefined}
              onGrokReasoningEffortChange={(effort) =>
                agentSelection.selectAgentConfiguration({ provider: 'grok', grokReasoningEffort: effort })
              }
              bubbleThinkingLevel={agentSelection.bubbleThinkingLevel ?? undefined}
              onBubbleThinkingLevelChange={(level) =>
                agentSelection.selectAgentConfiguration({ provider: 'bubble', bubbleThinkingLevel: level })
              }
              deepseekReasoningEffort={agentSelection.deepseekReasoningEffort}
              onDeepseekReasoningEffortChange={agentSelection.setDeepseekReasoningEffort}
              codexFastMode={agentSelection.codexFastMode}
              onCodexFastModeChange={(enabled) =>
                agentSelection.selectAgentConfiguration({ provider: 'codex', codexFastMode: enabled })
              }
              kimiThinkingOptions={agentSelection.kimiThinkingOptions}
              kimiThinkingChecked={agentSelection.kimiThinkingChecked}
              onKimiThinkingChange={agentSelection.setKimiThinking}
              menuSide="top"
              bubbleModelsLoading={agentSelection.bubbleModelsLoading}
            />
            <span className="flex-1" />
            <button
              type="button"
              disabled={submitting || (!prompt.trim() && !title.trim())}
              onClick={() => void submit(false)}
              className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save to Inbox
            </button>
            <button
              type="button"
              disabled={submitting || !prompt.trim() || !projectCwd.trim()}
              onClick={() => void submit(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3.5 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start now
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
