import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { toast } from 'sonner';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  SlidersHorizontal,
  X,
} from './icons';
import { SettingsToggle } from './settings/SettingsPrimitives';
import { AgentIcon, ComposerAgentModelPicker } from './ComposerAgentControls';
import { BoardTaskDetail } from './BoardTaskDetail';
import { confirmDialog } from './ui/confirm-dialog';
import { useAppStore } from '../store/useAppStore';
import { useComposerAgentSelection } from '../hooks/useComposerAgentSelection';
import { sendEvent } from '../hooks/useIPC';
import { useTabsStore } from '../store/useTabsStore';
import { useTaskGit, useTaskGitStore } from '../store/useTaskGitStore';
import {
  BOARD_STAGES,
  ensureBoardSessionSync,
  latestTaskSession,
  useBoardStore,
  type BoardSessionConfig,
  type BoardStage,
  type BoardTask,
} from '../store/useBoardStore';
import {
  DiffStat,
  PullRequestBadge,
  STAGE_META,
  RunBadge,
  StageIcon,
  deriveRunState,
  modelDisplayLabel,
  projectName,
  providerLabel,
  relativeTime,
} from './board-support';
import type { SessionView } from '../types';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { createBoardTaskStartPayload } from '../utils/board-task-start';

export function BoardView() {
  const sessions = useAppStore((state) => state.sessions);
  const currentProjectCwd = useAppStore((state) => state.projectCwd);
  const activeChannelByProject = useAppStore((state) => state.activeChannelByProject);

  const tasks = useBoardStore((state) => state.tasks);
  const addTask = useBoardStore((state) => state.addTask);
  const updateTask = useBoardStore((state) => state.updateTask);
  const setStage = useBoardStore((state) => state.setStage);
  const renameTask = useBoardStore((state) => state.renameTask);
  const attachSession = useBoardStore((state) => state.attachSession);
  const removeTask = useBoardStore((state) => state.removeTask);
  const markSeen = useBoardStore((state) => state.markSeen);

  const [projectFilter, setProjectFilter] = useState<string | 'all'>('all');
  // Lifted to the store so app tabs can bookmark and restore the open task.
  const selectedTaskId = useBoardStore((state) => state.selectedTaskId);
  const setSelectedTaskId = useBoardStore((state) => state.setSelectedTask);
  const showEmptyColumns = useBoardStore((state) => state.showEmptyColumns);
  const setShowEmptyColumns = useBoardStore((state) => state.setShowEmptyColumns);
  const hiddenStages = useBoardStore((state) => state.hiddenStages);
  const setStageHidden = useBoardStore((state) => state.setStageHidden);
  const [composerTaskId, setComposerTaskId] = useState<string | null | undefined>(undefined);
  // Column the "+" was pressed in: a new task lands there instead of Backlog.
  const [composerStage, setComposerStage] = useState<BoardStage>('backlog');
  const [columnMenuStage, setColumnMenuStage] = useState<BoardStage | null>(null);
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

  // Pull-request state on cards comes from the (cached) PR directory; keep
  // it reasonably fresh while the board is on screen.
  const refreshPullRequests = useTaskGitStore((state) => state.refreshPullRequests);
  useEffect(() => {
    void refreshPullRequests();
    const timer = window.setInterval(() => void refreshPullRequests(true), 3 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshPullRequests]);

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
    const groups: Record<BoardStage, BoardTask[]> = {
      backlog: [],
      todo: [],
      working: [],
      review: [],
      done: [],
      canceled: [],
    };
    for (const task of visibleTasks) groups[task.stage].push(task);
    return groups;
  }, [visibleTasks]);

  const selectedTask = selectedTaskId ? tasks[selectedTaskId] ?? null : null;

  // Opens as a separate tab so the board/task tab keeps its context.
  const openSession = (sessionId: string) => {
    useTabsStore.getState().openTab({ kind: 'chat', sessionId });
  };

  const openTask = (task: BoardTask) => {
    setSelectedTaskId(task.id);
    markSeen(task.id);
  };

  const startTask = async (task: BoardTask): Promise<void> => {
    if (!task.title.trim() || !task.projectCwd) {
      setComposerTaskId(task.id);
      return;
    }

    const result = await window.electron.startBackgroundSession(
      createBoardTaskStartPayload(
        task,
        activeChannelByProject[task.projectCwd] || DEFAULT_WORKSPACE_CHANNEL_ID
      )
    );
    if (result.sessionId) {
      attachSession(task.id, result.sessionId);
      setStage(task.id, 'working', { auto: true });
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
  // board. Review/Done/Canceled cards move back to Working — the agent is on
  // it again. The composer opens a new thread card (`newCard`, the default);
  // an in-card reply continues the current card.
  const continueTask = (
    task: BoardTask,
    prompt: string,
    opts?: { newCard?: boolean }
  ): boolean => {
    const latest = latestTaskSession(task, sessions);
    if (!latest) {
      toast.error('This task has no session to continue.');
      return false;
    }
    // Recorded before the send so the mark precedes the message timestamp.
    useBoardStore.getState().markFollowUp(task.id, opts?.newCard !== false);
    window.electron.sendClientEvent({
      type: 'session.continue',
      payload: { sessionId: latest.id, prompt },
    });
    if (task.stage === 'review' || task.stage === 'done' || task.stage === 'canceled') {
      setStage(task.id, 'working', { auto: true });
    }
    return true;
  };

  const handleDrop = (event: DragEvent, stage: BoardStage) => {
    event.preventDefault();
    setDragOverStage(null);
    const taskId = event.dataTransfer.getData('text/board-task');
    if (taskId && tasks[taskId]) setStage(taskId, stage);
  };

  const deleteTask = (task: BoardTask) => {
    // Match the sidebar's conversation deletion flow: close the context menu
    // first, then show the shared confirmation dialog before sending the same
    // permanent session.delete event.
    setCardMenu(null);
    window.setTimeout(() => {
      void (async () => {
        const sessionIds = [...new Set(task.sessionIds)].filter((sessionId) => sessions[sessionId]);
        const runningCount = sessionIds.filter((sessionId) => {
          const status = sessions[sessionId]?.status;
          return status === 'running' || status === 'stopping';
        }).length;
        const conversationDetail =
          sessionIds.length === 0
            ? 'This permanently removes the task.'
            : sessionIds.length === 1
              ? 'This permanently removes the task and its conversation.'
              : `This permanently removes the task and all ${sessionIds.length} conversations in it.`;
        const runningDetail =
          runningCount === 0
            ? ''
            : runningCount === 1
              ? ' The running task will be stopped.'
              : ` ${runningCount} running conversations will be stopped.`;
        const confirmed = await confirmDialog({
          title: `Delete ${task.title}?`,
          description: `${conversationDetail}${runningDetail}`,
          confirmLabel: 'Delete task',
        });
        if (!confirmed) return;

        // Remove the board entity immediately and remember its sessions as
        // excluded so an intervening session.list cannot recreate the card.
        removeTask(task.id);
        if (selectedTaskId === task.id) setSelectedTaskId(null);
        for (const sessionId of sessionIds) {
          sendEvent({ type: 'session.delete', payload: { sessionId } });
        }
      })();
    }, 0);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--chat-pane-surface)]">

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
          onUpdateDescription={(description) => updateTask(selectedTask.id, { description })}
          onStart={() => void startTask(selectedTask)}
          onContinue={(prompt, opts) => continueTask(selectedTask, prompt, opts)}
          onRemove={() => deleteTask(selectedTask)}
          projectOptions={composerProjectOptions}
          onUpdateProject={(projectCwd) => updateTask(selectedTask.id, { projectCwd })}
          onUpdateAgent={(provider) => updateTask(selectedTask.id, { sessionConfig: { provider } })}
        />
      ) : (
        <>
      <div className="flex flex-shrink-0 items-center justify-between gap-3 px-5 pb-3 pt-1">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          Tasks
        </h1>

        <div className="no-drag relative flex items-center gap-1.5">
          <ProjectFilterMenu
            projectFilter={projectFilter}
            projectOptions={projectOptions}
            totalCount={taskList.length}
            countFor={(key) => taskList.filter((task) => (task.projectCwd || '') === key).length}
            onSelect={setProjectFilter}
          />
          <BoardOptionsMenu
            showEmptyColumns={showEmptyColumns}
            onShowEmptyColumnsChange={setShowEmptyColumns}
            hiddenStages={hiddenStages}
            onStageHiddenChange={setStageHidden}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-5">
        {BOARD_STAGES.every((stage) => hiddenStages[stage]) ? (
          <div className="flex flex-1 items-center justify-center text-[12.5px] text-[var(--text-muted)]">
            All columns are hidden. Show them again from the board options.
          </div>
        ) : null}
        {BOARD_STAGES.filter(
          (stage) => !hiddenStages[stage] && (showEmptyColumns || byStage[stage].length > 0)
        ).map((stage) => {
          const meta = STAGE_META[stage];
          const stageTasks = byStage[stage];
          return (
            <section
              key={stage}
              className={`flex min-h-0 w-[348px] flex-shrink-0 flex-col rounded-xl bg-[var(--board-column-surface)] transition-colors ${
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
              <div className="flex flex-shrink-0 items-center gap-2 py-2 pl-3 pr-2">
                <StageIcon stage={stage} className="h-3.5 w-3.5" />
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {meta.label}
                </span>
                <span className="text-[12px] text-[var(--text-muted)]">{stageTasks.length}</span>
                {/* Linear-style column actions: overflow menu, then create. */}
                <div className="ml-auto flex items-center gap-0.5">
                  <ColumnMenu
                    label={meta.label}
                    open={columnMenuStage === stage}
                    onOpenChange={(open) => setColumnMenuStage(open ? stage : null)}
                    onHide={() => setStageHidden(stage, true)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setComposerStage(stage);
                      setComposerTaskId(null);
                    }}
                    title={`New task in ${meta.label}`}
                    aria-label={`New task in ${meta.label}`}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {stageTasks.map((task) => (
                    <BoardCard
                      key={task.id}
                      task={task}
                      session={latestTaskSession(task, sessions)}
                      selected={task.id === selectedTaskId}
                      showProject={projectFilter === 'all'}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) {
                          useTabsStore
                            .getState()
                            .openTab({ kind: 'board', taskId: task.id }, { background: true });
                          return;
                        }
                        openTask(task);
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          useTabsStore
                            .getState()
                            .openTab({ kind: 'board', taskId: task.id }, { background: true });
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setCardMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
                      }}
                    />
                ))}
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
              deleteTask(tasks[cardMenu.taskId]);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--error)]"
          >
            Delete
          </button>
        </div>
      ) : null}

      {composerTaskId !== undefined ? (
        <BoardTaskComposer
          task={composerTaskId ? tasks[composerTaskId] || null : null}
          stage={(composerTaskId && tasks[composerTaskId]?.stage) || composerStage}
          projectOptions={composerProjectOptions}
          initialProjectCwd={
            (projectFilter !== 'all' && projectFilter) || currentProjectCwd || composerProjectOptions[0] || ''
          }
          onClose={() => setComposerTaskId(undefined)}
          onSubmit={async ({ title, description, projectCwd, sessionConfig, stage: nextStage, startNow }) => {
            const taskId = composerTaskId
              ? composerTaskId
              : addTask({ title, description, projectCwd, sessionConfig, stage: nextStage });
            if (composerTaskId) {
              updateTask(composerTaskId, { title, description, projectCwd, sessionConfig });
              if (tasks[composerTaskId]?.stage !== nextStage) setStage(composerTaskId, nextStage);
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

/** Linear-style board display options behind a sliders button. */
function BoardOptionsMenu({
  showEmptyColumns,
  onShowEmptyColumnsChange,
  hiddenStages,
  onStageHiddenChange,
}: {
  showEmptyColumns: boolean;
  onShowEmptyColumnsChange: (value: boolean) => void;
  hiddenStages: Partial<Record<BoardStage, true>>;
  onStageHiddenChange: (stage: BoardStage, hidden: boolean) => void;
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Board options"
        className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
          open
            ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)]'
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="popover-surface absolute right-0 top-full z-40 mt-1.5 w-[240px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] py-2 shadow-lg">
          <div className="px-3 pb-1.5 text-[11.5px] font-medium text-[var(--text-muted)]">
            Board options
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-[12.5px] text-[var(--text-primary)]">Show empty columns</span>
            <SettingsToggle
              checked={showEmptyColumns}
              onChange={onShowEmptyColumnsChange}
              ariaLabel="Show empty columns"
            />
          </div>
          <div className="mx-3 my-1.5 border-t border-[var(--border)]" />
          <div className="px-3 pb-1.5 text-[11.5px] font-medium text-[var(--text-muted)]">Columns</div>
          {BOARD_STAGES.map((stage) => (
            <div key={stage} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="flex items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                <StageIcon stage={stage} className="h-3.5 w-3.5" />
                {STAGE_META[stage].label}
              </span>
              <SettingsToggle
                checked={!hiddenStages[stage]}
                onChange={(visible) => onStageHiddenChange(stage, !visible)}
                ariaLabel={`Show ${STAGE_META[stage].label} column`}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Column header overflow menu (Linear's "…"): hide the column. */
function ColumnMenu({
  label,
  open,
  onOpenChange,
  onHide,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onHide: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={`${label} column options`}
        aria-label={`${label} column options`}
        aria-expanded={open}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
          open ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
        }`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="popover-surface absolute right-0 top-full z-40 mt-1 w-[180px] p-1">
          {/* Inset, rounded hover like Linear: the highlight stays inside the
              popover padding instead of bleeding edge to edge. */}
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onHide();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          >
            Hide column
          </button>
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
  onAuxClick,
  onContextMenu,
}: {
  task: BoardTask;
  session: SessionView | null;
  selected: boolean;
  /** Only when the board mixes projects — a scoped board would repeat it on every card. */
  showProject: boolean;
  onClick: (event: ReactMouseEvent) => void;
  onAuxClick: (event: ReactMouseEvent) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const runState = deriveRunState(task, session);
  const git = useTaskGit(task, session);
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
      onAuxClick={onAuxClick}
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
      {showProject ? (
        <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-muted)]">
          <Folder className="h-2.5 w-2.5 flex-shrink-0" />
          <span className="truncate">{projectName(task.projectCwd)}</span>
        </div>
      ) : null}
      {provider ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
            <AgentIcon provider={provider} />
            <span className="truncate">{label}</span>
          </span>
        </div>
      ) : null}
      {git ? (
        // Only isolated-copy runs own a branch; local runs share the checkout.
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-2.5 w-2.5 flex-shrink-0 text-[var(--text-muted)]" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--text-secondary)]"
            title={git.branch}
          >
            {git.branch}
          </span>
          {git.changes && git.changes.files > 0 ? (
            <DiffStat
              files={git.changes.files}
              insertions={git.changes.insertions}
              deletions={git.changes.deletions}
              className="flex-shrink-0"
            />
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex min-h-[16px] items-center gap-2">
        {/* The column already says "Review" — only live runtime states earn a badge. */}
        {runState && runState !== 'ready' ? <RunBadge state={runState} /> : null}
        {git?.pr ? <PullRequestBadge pr={git.pr} /> : null}
        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
          {relativeTime(task.updatedAt)}
        </span>
      </div>
    </button>
  );
}

function BoardTaskComposer({
  task,
  stage,
  projectOptions,
  initialProjectCwd,
  onClose,
  onSubmit,
}: {
  task: BoardTask | null;
  /** Column the composer was opened from; the stage chip can change it. */
  stage: BoardStage;
  projectOptions: string[];
  initialProjectCwd: string;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    description: string;
    projectCwd: string | null;
    sessionConfig: Partial<BoardSessionConfig>;
    stage: BoardStage;
    startNow: boolean;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title === 'Untitled task' ? '' : task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [projectCwd, setProjectCwd] = useState(task?.projectCwd || initialProjectCwd);
  const [stageValue, setStageValue] = useState<BoardStage>(stage);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
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
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
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
        description: description.trim(),
        projectCwd: projectCwd.trim() || null,
        sessionConfig: buildSessionConfig(),
        stage: stageValue,
        startNow,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const stageLabel = STAGE_META[stageValue].label;
  const projectLabel = projectCwd.trim() ? projectName(projectCwd) : 'No project';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        {/* Linear "New issue" sheet: anchored near the top, borderless inputs,
            properties as a chip row, actions in a quiet footer. */}
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-50 flex max-h-[76vh] w-[min(760px,calc(100vw-40px))] -translate-x-1/2 flex-col rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_70px_rgba(15,18,25,0.24)]">
          <div className="flex items-center gap-2 px-4 pt-3.5">
            <span className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-[var(--border)] px-2 text-[12px] text-[var(--text-secondary)]">
              <Folder className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{projectLabel}</span>
            </span>
            <ChevronRight className="h-3 w-3 text-[var(--text-muted)]" />
            <Dialog.Title className="text-[13px] font-medium text-[var(--text-primary)]">
              {task ? 'Edit task' : 'New task'}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              {`Save the task to ${stageLabel}, or start an agent on it right away.`}
            </Dialog.Description>
            <span className="flex-1" />
            <Dialog.Close className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 px-5 pb-2 pt-4">
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  descriptionRef.current?.focus();
                }
              }}
              placeholder="What should the agent do?"
              aria-label="Task title"
              className="w-full bg-transparent text-[18px] font-semibold leading-7 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add task notes (not sent to the agent)…"
              aria-label="Task description"
              rows={5}
              className="mt-2 max-h-[40vh] min-h-[120px] w-full resize-none overflow-y-auto bg-transparent text-[13.5px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <ChipMenu
                label={stageLabel}
                icon={<StageIcon stage={stageValue} className="h-3.5 w-3.5" />}
                ariaLabel="Stage"
              >
                {(close) =>
                  BOARD_STAGES.map((option) => (
                    <ChipMenuItem
                      key={option}
                      selected={option === stageValue}
                      onClick={() => {
                        setStageValue(option);
                        close();
                      }}
                    >
                      <StageIcon stage={option} className="h-3.5 w-3.5" />
                      {STAGE_META[option].label}
                    </ChipMenuItem>
                  ))
                }
              </ChipMenu>
              <ChipMenu
                label={projectLabel}
                icon={<Folder className="h-3.5 w-3.5" />}
                ariaLabel="Project"
                width={280}
              >
                {(close) => (
                  <>
                    <ChipMenuItem
                      selected={!projectCwd.trim()}
                      onClick={() => {
                        setProjectCwd('');
                        close();
                      }}
                    >
                      No project
                    </ChipMenuItem>
                    {projectCwd && !projectOptions.includes(projectCwd) ? (
                      <ChipMenuItem selected onClick={close} detail={projectCwd}>
                        {projectName(projectCwd)}
                      </ChipMenuItem>
                    ) : null}
                    {projectOptions.map((cwd) => (
                      <ChipMenuItem
                        key={cwd}
                        selected={cwd === projectCwd}
                        detail={cwd}
                        onClick={() => {
                          setProjectCwd(cwd);
                          close();
                        }}
                      >
                        {projectName(cwd)}
                      </ChipMenuItem>
                    ))}
                    <div className="mx-1 my-1 border-t border-[var(--border)]" />
                    <ChipMenuItem
                      onClick={async () => {
                        close();
                        const selected = await window.electron.selectDirectory();
                        if (selected) setProjectCwd(selected);
                      }}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Browse…
                    </ChipMenuItem>
                  </>
                )}
              </ChipMenu>
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
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <button
              type="button"
              disabled={submitting || !title.trim()}
              onClick={() => void submit(false)}
              className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {`Save to ${stageLabel}`}
            </button>
            {task && task.sessionIds.length > 0 ? null : (
              // One task, one run: a task that already ran is continued from
              // its detail page, never started a second time.
              <button
                type="button"
                disabled={submitting || !title.trim() || !projectCwd.trim()}
                onClick={() => void submit(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3.5 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Start now
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Linear-style property chip: a bordered pill that opens a small option list
 * beneath it. Children receive `close` so a pick can dismiss the menu.
 */
function ChipMenu({
  label,
  icon,
  ariaLabel,
  width = 200,
  children,
}: {
  label: string;
  icon: ReactNode;
  ariaLabel: string;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // Stop here so Escape closes the chip menu without closing the dialog.
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`${ariaLabel}: ${label}`}
        aria-expanded={open}
        className={`inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[12.5px] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
          open ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <div
          className="popover-surface absolute left-0 top-full z-50 mt-1 max-h-[280px] overflow-y-auto p-1"
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function ChipMenuItem({
  selected,
  detail,
  onClick,
  children,
}: {
  selected?: boolean;
  detail?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={detail}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
        selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {selected ? <Check className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" /> : null}
    </button>
  );
}
