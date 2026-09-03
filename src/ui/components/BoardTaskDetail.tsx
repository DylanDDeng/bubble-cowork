import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleX,
  Clock,
  ExternalLink,
  FileDiff,
  Folder,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  User,
} from './icons';
import { toast } from 'sonner';
import { AgentIcon } from './ComposerAgentControls';
import { MDContent } from '../render/markdown';
import { useUserProfile } from '../hooks/useUserProfile';
import { avatarColorFor, initialsOf } from '../utils/user-avatar';
import { useAppStore } from '../store/useAppStore';
import { useTaskGit, useTaskGitStore } from '../store/useTaskGitStore';
import { PROVIDERS } from '../utils/provider';
import {
  BOARD_STAGES,
  latestTaskSession,
  type BoardStage,
  type BoardTask,
  type BoardTaskEvent,
} from '../store/useBoardStore';
import {
  DiffStat,
  STAGE_META,
  StageIcon,
  modelDisplayLabel,
  projectName,
  providerLabel,
  pullRequestTone,
  relativeTime,
} from './board-support';
import { extractToolChangeRecords } from '../utils/change-records';
import type { AgentProvider, SessionView } from '../types';

/**
 * The Activity timeline interleaves two shapes, Linear-style: thread cards
 * (one per conversation round — a user message and the agent's replies to
 * it) and groups of one-line system events between them. Splitting runs
 * into rounds is what keeps chronology honest: a follow-up sent after a
 * stage change must render after that event, not inside an earlier card.
 */
type TimelineItem = { kind: 'user' | 'agent'; text: string; time?: number };

type ActivityEntry =
  | {
      kind: 'round';
      sessionId: string;
      runNumber: number;
      firstOfRun: boolean;
      lastOfRun: boolean;
      items: TimelineItem[];
      time: number;
    }
  | { kind: 'events'; events: BoardTaskEvent[]; time: number };

/**
 * A chronological mini-transcript of one session: every follow-up the user
 * sent, and the agent's closing text for each turn. Built from message
 * order, never from session status — earlier turns must not vanish when a
 * new one starts. This is the session transcript, not a deduplicated
 * summary: a task description may repeat the opening request, but that must
 * never make the user's actual first message disappear here.
 */
function extractSessionTimeline(session: SessionView): TimelineItem[] {
  const items: TimelineItem[] = [];
  let pendingAgent: { text: string; time?: number } | null = null;
  for (const message of session.messages) {
    if (message.type === 'user_prompt') {
      if (pendingAgent) {
        items.push({ kind: 'agent', ...pendingAgent });
        pendingAgent = null;
      }
      items.push({ kind: 'user', text: message.prompt, time: message.createdAt });
    } else if (message.type === 'assistant' && !message.parentToolUseId) {
      const texts = message.message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean);
      // Keep only the turn's last text — it supersedes interim narration.
      if (texts.length > 0) pendingAgent = { text: texts.join('\n'), time: message.createdAt };
    }
  }
  if (pendingAgent) items.push({ kind: 'agent', ...pendingAgent });
  return items;
}

export function BoardTaskDetail({
  task,
  sessions,
  orderedTaskIds,
  onBack,
  onSelectTask,
  onOpenSession,
  onSetStage,
  onRename,
  onUpdateDescription,
  onStart,
  onContinue,
  onRemove,
  projectOptions,
  onUpdateProject,
  onUpdateAgent,
}: {
  task: BoardTask;
  sessions: Record<string, SessionView>;
  /** Board order of the currently visible tasks, for prev/next navigation. */
  orderedTaskIds: string[];
  onBack: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onSetStage: (stage: BoardStage) => void;
  onRename: (title: string) => void;
  onUpdateDescription: (description: string) => void;
  onStart: () => void;
  /** Send a follow-up prompt to the latest run. Returns false if it could not send. */
  onContinue: (prompt: string, opts?: { newCard?: boolean }) => boolean;
  onRemove: () => void;
  /** Project choices for the rail dropdown while the task has not run yet. */
  projectOptions: string[];
  onUpdateProject: (projectCwd: string) => void;
  onUpdateAgent: (provider: AgentProvider) => void;
}) {
  const requestSessionHydration = useAppStore((state) => state.requestSessionHydration);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description);
  const [followUp, setFollowUp] = useState('');
  const followUpRef = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);

  // The title is a wrapping textarea so long titles show in full; keep its
  // height matched to the content.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [titleDraft]);

  // The description edits in place (Linear-style), so its textarea also has to
  // track content height instead of scrolling inside a fixed box.
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [descriptionDraft, editingDescription]);

  useEffect(() => {
    setTitleDraft(task.title);
    setDescriptionDraft(task.description);
    setEditingDescription(false);
  }, [task.id, task.title, task.description]);

  // The activity timeline reads linked sessions' messages; make sure they load.
  useEffect(() => {
    for (const sessionId of task.sessionIds) {
      if (sessions[sessionId] && !sessions[sessionId].hydrated) {
        requestSessionHydration(sessionId);
      }
    }
  }, [task.sessionIds, sessions, requestSessionHydration]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      onBack();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // Merge system events and conversation rounds into one chronological
  // stream. Each round's position is its user message's time; events that
  // fired at the same moment (stage moved as the round was sent) sort ahead
  // of the round card.
  const activityEntries = useMemo<ActivityEntry[]>(() => {
    const merged: Array<
      | Extract<ActivityEntry, { kind: 'round' }>
      | { kind: 'event'; event: BoardTaskEvent; time: number }
    > = [];
    task.sessionIds.forEach((sessionId, index) => {
      const session = sessions[sessionId];
      const runNumber = index + 1;
      const fallbackTime = task.createdAt + index + 1;
      if (!session?.hydrated) {
        // Missing or not yet hydrated: one placeholder card holds its spot.
        merged.push({
          kind: 'round',
          sessionId,
          runNumber,
          firstOfRun: true,
          lastOfRun: true,
          items: [],
          time: fallbackTime,
        });
        return;
      }
      const rounds: TimelineItem[][] = [];
      for (const item of extractSessionTimeline(session)) {
        if (item.kind === 'user' || rounds.length === 0) rounds.push([item]);
        else rounds[rounds.length - 1].push(item);
      }
      if (rounds.length === 0) rounds.push([]);
      // Group rounds into thread cards. Sends record their intent: the
      // bottom composer marks `newCard`, an in-card reply marks the
      // opposite. Rounds without a marker (pre-feature history) split
      // where system events interleave, so those events keep their place
      // in the timeline instead of piling up under one giant card.
      const marks = task.cardMarks ?? [];
      const events = task.events ?? [];
      let card: Extract<ActivityEntry, { kind: 'round' }> | null = null;
      let prevTime = -Infinity;
      rounds.forEach((items, roundIndex) => {
        const time = items[0]?.time ?? fallbackTime + roundIndex;
        const lastOfRun = roundIndex === rounds.length - 1;
        const mark = marks.filter((m) => m.at > prevTime && m.at <= time).pop();
        const opensCard = mark
          ? mark.newCard
          : events.some((e) => e.at > prevTime && e.at <= time);
        if (card && !opensCard) {
          card.items = [...card.items, ...items];
          card.lastOfRun = lastOfRun;
        } else {
          card = {
            kind: 'round',
            sessionId,
            runNumber,
            firstOfRun: roundIndex === 0,
            lastOfRun,
            items,
            time,
          };
          merged.push(card);
        }
        prevTime = time;
      });
    });
    for (const event of task.events ?? []) merged.push({ kind: 'event', event, time: event.at });
    merged.sort(
      (a, b) => a.time - b.time || (a.kind === 'event' ? -1 : 1) - (b.kind === 'event' ? -1 : 1)
    );
    const entries: ActivityEntry[] = [];
    for (const item of merged) {
      if (item.kind === 'round') {
        entries.push(item);
        continue;
      }
      const last = entries[entries.length - 1];
      if (last?.kind === 'events') last.events.push(item.event);
      else entries.push({ kind: 'events', events: [item.event], time: item.time });
    }
    return entries;
  }, [task.sessionIds, task.events, task.cardMarks, task.createdAt, sessions]);

  // The reply box lives on the newest thread card only: replying targets the
  // latest run's context, so offering it on older cards would misplace the
  // agent's answer.
  const lastCardIndex = useMemo(() => {
    for (let i = activityEntries.length - 1; i >= 0; i -= 1) {
      if (activityEntries[i].kind === 'round') return i;
    }
    return -1;
  }, [activityEntries]);

  const hasLinkedSession = task.sessionIds.length > 0;
  const hasDescription = Boolean(task.description.trim());

  const latest = latestTaskSession(task, sessions);
  const taskIndex = orderedTaskIds.indexOf(task.id);
  const prevTaskId = taskIndex > 0 ? orderedTaskIds[taskIndex - 1] : null;
  const nextTaskId =
    taskIndex >= 0 && taskIndex < orderedTaskIds.length - 1 ? orderedTaskIds[taskIndex + 1] : null;

  const latestRunning = latest?.status === 'running' || latest?.status === 'stopping';
  const provider = latest?.provider || task.sessionConfig.provider;
  const model = latest?.model || task.sessionConfig.model;
  const git = useTaskGit(task, latest);
  const createPullRequest = useTaskGitStore((state) => state.createPullRequest);
  const [creatingPr, setCreatingPr] = useState(false);
  // Project and agent are bound once a run exists; before that they are
  // editable in place, Linear-style.
  const hasRun = task.sessionIds.length > 0;

  const handleCreatePullRequest = async () => {
    if (!git || creatingPr) return;
    setCreatingPr(true);
    try {
      const result = await createPullRequest(git.cwd);
      if (!result.ok) toast.error(result.message || 'Could not create the pull request.');
    } finally {
      setCreatingPr(false);
    }
  };

  // ⌘⌫ removes the task, like the overflow menu — unless typing somewhere.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onRemove();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onRemove]);

  const commitTitle = () => {
    if (titleDraft.trim() && titleDraft.trim() !== task.title) onRename(titleDraft);
    else setTitleDraft(task.title);
  };

  const openDescriptionEditor = () => {
    setDescriptionDraft(task.description);
    setEditingDescription(true);
  };

  const commitDescription = () => {
    setEditingDescription(false);
    if (descriptionDraft.trim() !== task.description) onUpdateDescription(descriptionDraft);
    else setDescriptionDraft(task.description);
  };

  const sendFollowUp = () => {
    const prompt = followUp.trim();
    if (!prompt) return;
    if (onContinue(prompt)) {
      setFollowUp('');
      if (followUpRef.current) followUpRef.current.style.height = 'auto';
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-4">
        <button
          type="button"
          onClick={onBack}
          className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Tasks
        </button>
        <span className="text-[12px] text-[var(--text-muted)]">/</span>
        <span className="max-w-[180px] truncate text-[12.5px] text-[var(--text-secondary)]">
          {projectName(task.projectCwd)}
        </span>
        <span className="text-[12px] text-[var(--text-muted)]">/</span>
        <span className="min-w-0 max-w-[320px] truncate text-[12.5px] font-medium text-[var(--text-primary)]">
          {task.title}
        </span>
        <span className="flex-1" />
        {/* Header = navigation only. Open session is a jump, like "← Tasks". */}
        <button
          type="button"
          disabled={!latest}
          onClick={() => latest && onOpenSession(latest.id)}
          className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          Open session
          <ExternalLink className="h-3 w-3" />
        </button>
        <OverflowMenu onRemove={onRemove} />
        <span className="mx-1.5 h-4 w-px bg-[var(--border)]" />
        {taskIndex >= 0 ? (
          <span className="no-drag mr-1 text-[11.5px] tabular-nums text-[var(--text-muted)]">
            {taskIndex + 1} / {orderedTaskIds.length}
          </span>
        ) : null}
        <button
          type="button"
          disabled={!prevTaskId}
          onClick={() => prevTaskId && onSelectTask(prevTaskId)}
          title="Previous task"
          className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!nextTaskId}
          onClick={() => nextTaskId && onSelectTask(nextTaskId)}
          title="Next task"
          className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[720px] px-8 pb-6 pt-7">
              <textarea
                ref={titleRef}
                rows={1}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    (event.target as HTMLTextAreaElement).blur();
                  }
                }}
                className="w-full resize-none overflow-hidden bg-transparent text-[21px] font-semibold leading-snug tracking-[-0.015em] text-[var(--text-primary)] outline-none"
                aria-label="Task title"
              />

              {editingDescription ? (
                <textarea
                  ref={descriptionRef}
                  autoFocus
                  value={descriptionDraft}
                  placeholder="Add a description…"
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  onBlur={commitDescription}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setDescriptionDraft(task.description);
                      setEditingDescription(false);
                    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      commitDescription();
                    }
                  }}
                  className="mt-3 w-full resize-none overflow-hidden bg-transparent text-[13px] leading-[1.6] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  aria-label="Task description"
                />
              ) : hasDescription ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={openDescriptionEditor}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openDescriptionEditor();
                  }}
                  className="mt-3 cursor-text whitespace-pre-wrap text-[13px] leading-[1.6] text-[var(--text-secondary)]"
                >
                  {task.description}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={openDescriptionEditor}
                  className="mt-3 w-full text-left text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                >
                  Add a description…
                </button>
              )}

              <div className="mt-8 border-t border-[var(--border)] pt-5">
                <div className="mb-3 text-[13px] text-[var(--text-muted)]">Activity</div>
                <div className="space-y-5">
                  {activityEntries.map((entry, index) =>
                    entry.kind === 'round' ? (
                      <RoundCard
                        key={`round-${index}`}
                        session={sessions[entry.sessionId] || null}
                        items={entry.items}
                        runNumber={entry.runNumber}
                        showRunNumber={task.sessionIds.length > 1 && entry.firstOfRun}
                        showExtras={entry.lastOfRun}
                        onOpenSession={onOpenSession}
                        onReply={
                          index === lastCardIndex && hasLinkedSession
                            ? (prompt) => onContinue(prompt, { newCard: false })
                            : undefined
                        }
                      />
                    ) : (
                      <EventGroup key={`events-${index}`} events={entry.events} />
                    )
                  )}
                </div>
                {task.sessionIds.length === 0 ? (
                  <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                    No runs yet. Starting this task creates a new session
                    {task.projectCwd ? ` in ${projectName(task.projectCwd)}` : ''} and its activity
                    shows up here.
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex-shrink-0 px-8 pb-5 pt-2">
            <div className="mx-auto w-full max-w-[720px]">
              {task.sessionIds.length === 0 ? (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={onStart}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3.5 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-85"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Start Task
                  </button>
                  <span className="text-[12px] text-[var(--text-muted)]">
                    Runs in the background — you stay on the board.
                  </span>
                </div>
              ) : latestRunning ? (
                <div className="flex items-center gap-2 rounded-[10px] bg-[var(--bg-secondary)] px-3.5 py-2.5 text-[12.5px] text-[var(--text-secondary)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
                  {providerLabel(latest?.provider) || 'The agent'} is working.
                </div>
              ) : (
                // Mirrors the session composer (PromptInput's chat surface):
                // same radii, shadow, focus transition, editor and send button.
                <div className="group relative rounded-[28px] bg-transparent transition-shadow duration-200">
                  <div className="rounded-[26px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)] transition-[border-color,box-shadow] duration-200 focus-within:border-[color-mix(in_srgb,var(--border)_92%,transparent)] focus-within:shadow-[0_20px_52px_rgba(15,23,42,0.12)]">
                    <textarea
                      ref={followUpRef}
                      value={followUp}
                      onChange={(event) => {
                        setFollowUp(event.target.value);
                        const target = event.target;
                        target.style.height = 'auto';
                        target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          sendFollowUp();
                        }
                      }}
                      rows={1}
                      placeholder={
                        task.stage === 'review'
                          ? 'Request changes — this sends feedback and moves the task back to Working…'
                          : 'Continue the task with a follow-up…'
                      }
                      className="min-h-[56px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    />
                    <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5">
                        {provider ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]"
                            title="Follow-ups continue this task's session"
                          >
                            <AgentIcon provider={provider} />
                            {modelDisplayLabel(provider, model) || providerLabel(provider)}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        disabled={!followUp.trim()}
                        onClick={sendFollowUp}
                        title="Send"
                        aria-label="Send"
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100"
                      >
                        <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="w-[316px] flex-shrink-0 overflow-y-auto pb-5 pl-4 pr-16 pt-4">
          <PropertyGroup label="Properties">
            <PropertyRow label="Stage">
              <StageMenu stage={task.stage} onSetStage={onSetStage} />
            </PropertyRow>
            <PropertyRow label="Project">
              {hasRun ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]"
                  title={task.projectCwd || undefined}
                >
                  <Folder className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{projectName(task.projectCwd)}</span>
                </span>
              ) : (
                <PropertyMenu
                  value={task.projectCwd}
                  placeholder="Choose a project…"
                  options={[...new Set([task.projectCwd, ...projectOptions])]
                    .filter((cwd): cwd is string => Boolean(cwd))
                    .map((cwd) => ({
                    key: cwd,
                    label: projectName(cwd),
                    title: cwd,
                    icon: <Folder className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />,
                  }))}
                  onSelect={onUpdateProject}
                />
              )}
            </PropertyRow>
            <PropertyRow label="Agent">
              {hasRun ? (
                provider ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]">
                    <AgentIcon provider={provider} />
                    <span className="truncate">{providerLabel(provider)}</span>
                  </span>
                ) : (
                  <span className="text-[12px] text-[var(--text-muted)]">None</span>
                )
              ) : (
                <PropertyMenu
                  value={provider || null}
                  placeholder="Choose an agent…"
                  options={PROVIDERS.map((entry) => ({
                    key: entry.id,
                    label: entry.label,
                    icon: <AgentIcon provider={entry.id} />,
                  }))}
                  onSelect={(key) => onUpdateAgent(key as AgentProvider)}
                />
              )}
            </PropertyRow>
            {model ? (
              <PropertyRow label="Model">
                <span className="truncate text-[12px] text-[var(--text-primary)]" title={model}>
                  {modelDisplayLabel(provider, model) || model}
                </span>
              </PropertyRow>
            ) : null}
            <PropertyRow label="Created">
              <span className="text-[12px] text-[var(--text-secondary)]">
                {relativeTime(task.createdAt)} ago
              </span>
            </PropertyRow>
            <PropertyRow label="Updated">
              <span className="text-[12px] text-[var(--text-secondary)]">
                {relativeTime(task.updatedAt)} ago
              </span>
            </PropertyRow>
          </PropertyGroup>

          {git ? (
            // Data only. The one action here is the PR row's empty state.
            <PropertyGroup label="Git">
              <PropertyRow label="Branch">
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]"
                  title={git.branch}
                >
                  <GitBranch className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate font-mono text-[11.5px]">{git.branch}</span>
                </span>
              </PropertyRow>
              {git.base && git.base !== git.branch ? (
                <PropertyRow label="Base">
                  <span className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
                    {git.base}
                  </span>
                </PropertyRow>
              ) : null}
              {git.changes ? (
                <PropertyRow label="Changes">
                  {git.changes.files > 0 ? (
                    <DiffStat
                      files={git.changes.files}
                      insertions={git.changes.insertions}
                      deletions={git.changes.deletions}
                      className="text-[12px]"
                    />
                  ) : (
                    <span className="text-[12px] text-[var(--text-muted)]">No changes yet</span>
                  )}
                </PropertyRow>
              ) : null}
              {/* On the base branch itself there is nothing to open a PR from. */}
              {git.pr || git.branch !== git.base ? (
                <PropertyRow label="PR">
                  {git.pr ? (
                    <button
                      type="button"
                      onClick={() => void window.electron.openExternalUrl(git.pr!.url)}
                      title={git.pr.title}
                      className={`group -ml-1.5 inline-flex h-[24px] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--sidebar-item-hover)] ${pullRequestTone(git.pr).className}`}
                    >
                      <GitPullRequest className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">
                        #{git.pr.number} {pullRequestTone(git.pr).label}
                      </span>
                      <ExternalLink className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={creatingPr}
                      onClick={() => void handleCreatePullRequest()}
                      className="-ml-1.5 inline-flex h-[24px] items-center gap-1.5 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60"
                    >
                      {creatingPr ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                      {creatingPr ? 'Creating pull request…' : 'Create pull request'}
                    </button>
                  )}
                </PropertyRow>
              ) : null}
            </PropertyGroup>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/**
 * A Linear-style thread card: one topic's rounds of conversation. The
 * bottom composer opens a new card; the in-card reply box (newest card
 * only) continues this one. Run-level extras (change summary, permission
 * waits, failure) render only on the run's last card, where they are
 * current.
 */
function RoundCard({
  session,
  items,
  runNumber,
  showRunNumber,
  showExtras,
  onOpenSession,
  onReply,
}: {
  session: SessionView | null;
  items: TimelineItem[];
  runNumber: number;
  showRunNumber: boolean;
  showExtras: boolean;
  onOpenSession: (sessionId: string) => void;
  /** Present on the newest card only: send a reply that stays in this card. */
  onReply?: (prompt: string) => boolean;
}) {
  const profileName = useUserProfile()?.displayName || null;
  const [replyDraft, setReplyDraft] = useState('');

  const changeSummary = useMemo(() => {
    if (!showExtras || !session?.hydrated) return null;
    const records = extractToolChangeRecords(session.messages).filter(
      (record) => record.operation !== 'bash'
    );
    if (records.length === 0) return null;
    const files = [...new Set(records.map((record) => record.fileName))];
    return {
      fileCount: files.length,
      files: files.slice(0, 3),
      added: records.reduce((sum, record) => sum + record.addedLines, 0),
      removed: records.reduce((sum, record) => sum + record.removedLines, 0),
    };
  }, [showExtras, session?.hydrated, session?.messages]);

  if (!session) {
    return (
      <div className="text-[12.5px] text-[var(--text-muted)]">
        {showRunNumber ? `Run ${runNumber} — ` : ''}session no longer available.
      </div>
    );
  }

  const running = session.status === 'running' || session.status === 'stopping';
  const needsPermission = showExtras && running && session.permissionRequests.length > 0;
  const showFailed = showExtras && session.status === 'error';
  // A fully empty card (hydrated round with nothing to show) renders nothing.
  if (
    session.hydrated &&
    items.length === 0 &&
    !changeSummary &&
    !needsPermission &&
    !showFailed &&
    !onReply
  ) {
    return null;
  }

  return (
    // Linear-style thread card: the conversation is framed so it reads as
    // foreground content against the flat system-event lines around it.
    // Rows inside are separated by hairlines, like replies in a thread.
    <div>
      {showRunNumber ? (
        <div className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
          Run {runNumber}
        </div>
      ) : null}
      <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--preview-surface)] px-4 shadow-[0_1px_2px_rgba(15,18,25,0.04)]">
        {!session.hydrated ? (
          <div className="py-3.5">
            <ActivityLine icon={<Loader2 className="h-3 w-3 animate-spin" />}>
              Loading activity…
            </ActivityLine>
          </div>
        ) : (
          <>
            {/* Comment-style blocks: avatar + name header, content full-width below. */}
            {items.map((item, index) => (
              <div key={index} className="py-3.5">
                <div className="flex items-center gap-2">
                  {item.kind === 'user' ? (
                    <UserAvatar name={profileName} />
                  ) : session.provider ? (
                    <AgentIcon provider={session.provider} />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  )}
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    {item.kind === 'user'
                      ? profileName || 'You'
                      : providerLabel(session.provider) || 'Agent'}
                  </span>
                  {item.time ? (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {relativeTime(item.time)} ago
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 text-[12.5px] leading-[1.55] text-[var(--text-primary)]">
                  {item.kind === 'user' ? (
                    <CollapsibleText text={item.text} />
                  ) : (
                    <RunSummary content={item.text} />
                  )}
                </div>
              </div>
            ))}
            {changeSummary ? (
              <div className="py-3">
                <ActivityLine icon={<FileDiff className="h-3 w-3" />}>
                  Changed {changeSummary.fileCount} file{changeSummary.fileCount === 1 ? '' : 's'}
                  {changeSummary.added || changeSummary.removed ? (
                    <span className="ml-1.5 font-mono text-[11px]">
                      <span className="text-[var(--success)]">+{changeSummary.added}</span>{' '}
                      <span className="text-[var(--error)]">−{changeSummary.removed}</span>
                    </span>
                  ) : null}
                  <span className="ml-1.5 text-[var(--text-muted)]">
                    {changeSummary.files.join(', ')}
                    {changeSummary.fileCount > changeSummary.files.length ? ', …' : ''}
                  </span>
                </ActivityLine>
              </div>
            ) : null}
            {needsPermission ? (
              <div className="py-3">
                <ActivityLine icon={<Clock className="h-3 w-3 text-[var(--warning)]" />}>
                  <span className="text-[var(--warning)]">
                    Waiting for your permission —{' '}
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.id)}
                      className="font-medium underline"
                    >
                      open the session to respond
                    </button>
                  </span>
                </ActivityLine>
              </div>
            ) : null}
            {showFailed ? (
              <div className="py-3">
                <ActivityLine icon={<CircleX className="h-3 w-3 text-[var(--error)]" />}>
                  <span className="text-[var(--error)]">The run failed.</span>
                </ActivityLine>
              </div>
            ) : null}
          </>
        )}
        {onReply ? (
          <div className="flex items-center gap-2 py-2.5">
            <UserAvatar name={profileName} />
            <input
              value={replyDraft}
              onChange={(event) => setReplyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                const prompt = replyDraft.trim();
                if (prompt && onReply(prompt)) setReplyDraft('');
              }}
              placeholder="Leave a reply…"
              aria-label="Reply in this thread"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The user's identity in the timeline — the same colored-initials avatar the
 * settings usage page renders, at line size. Falls back to a generic glyph
 * until the profile loads.
 */
function UserAvatar({ name }: { name: string | null }) {
  if (!name?.trim()) {
    return <User className="h-3.5 w-3.5" />;
  }
  return (
    <span
      className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white"
      style={{ backgroundColor: avatarColorFor(name) }}
      title={name}
      aria-label={name}
    >
      {initialsOf(name)}
    </span>
  );
}

const SUMMARY_COLLAPSE_LENGTH = 600;

/** A user message in the timeline: full text, collapsed past the threshold. */
function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > SUMMARY_COLLAPSE_LENGTH;
  return (
    <div className="min-w-0">
      <div
        className={
          collapsible && !expanded ? 'relative max-h-[176px] overflow-hidden' : undefined
        }
      >
        <span className="whitespace-pre-wrap">
          {text}
        </span>
        {collapsible && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[var(--bg-primary)]" />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11.5px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The agent's closing message, rendered as markdown. Long summaries start
 * clamped with a fade so one verbose run doesn't swallow the timeline.
 */
function RunSummary({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = content.length > SUMMARY_COLLAPSE_LENGTH;
  return (
    <div className="min-w-0">
      <div
        className={
          collapsible && !expanded ? 'relative max-h-[176px] overflow-hidden' : undefined
        }
      >
        <MDContent content={content} className="board-activity-markdown" />
        {collapsible && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[var(--bg-primary)]" />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11.5px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive system events, Linear-style: a "N activities" header
 * that collapses the group, with one-line rows underneath. Expanded by
 * default — the rows are visually light; the header exists so a long streak
 * of automation can be folded away.
 */
function EventGroup({ events }: { events: BoardTaskEvent[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const profileName = useUserProfile()?.displayName || null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {events.length} {events.length === 1 ? 'activity' : 'activities'}
      </button>
      {!collapsed ? (
        <div className="mt-2 space-y-1.5">
          {events.map((event, index) => (
            <EventRow key={index} event={event} profileName={profileName} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EventRow({ event, profileName }: { event: BoardTaskEvent; profileName: string | null }) {
  const you = (
    <span className="font-medium text-[var(--text-secondary)]">{profileName || 'You'}</span>
  );
  let icon: ReactNode;
  let text: ReactNode;
  switch (event.type) {
    case 'created':
      icon = <Plus className="h-3 w-3" />;
      text = <>{you} created this task</>;
      break;
    case 'description-updated':
      icon = <Pencil className="h-3 w-3" />;
      text = <>{you} updated the description</>;
      break;
    case 'stage': {
      const from = STAGE_META[event.from]?.label ?? event.from;
      const to = STAGE_META[event.to]?.label ?? event.to;
      icon = <StageIcon stage={event.to} className="h-3 w-3" />;
      text = event.auto ? (
        <>
          Moved from {from} to {to}
        </>
      ) : (
        <>
          {you} moved this from {from} to {to}
        </>
      );
      break;
    }
    case 'run-started':
      icon = <Play className="h-3 w-3" />;
      text = 'The agent started a run';
      break;
    case 'run-completed':
      icon = <Check className="h-3 w-3 text-[var(--success)]" />;
      text = 'The run completed';
      break;
    case 'run-failed':
      icon = <CircleX className="h-3 w-3 text-[var(--error)]" />;
      text = 'The run failed';
      break;
    case 'pr-opened':
      icon = <GitPullRequest className="h-3 w-3 text-[var(--success)]" />;
      text = (
        <>
          {you} opened <PullRequestLink number={event.number} url={event.url} />
          {event.base ? ` against ${event.base}` : ''}
        </>
      );
      break;
    case 'pr-merged':
      icon = <GitPullRequest className="h-3 w-3 text-[#8b5cf6]" />;
      text = (
        <>
          <PullRequestLink number={event.number} url={event.url} /> was merged
        </>
      );
      break;
    case 'pr-closed':
      icon = <GitPullRequest className="h-3 w-3 text-[var(--error)]" />;
      text = (
        <>
          <PullRequestLink number={event.number} url={event.url} /> was closed
        </>
      );
      break;
  }
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span className="flex-shrink-0 text-[11px]">{relativeTime(event.at)} ago</span>
    </div>
  );
}

function PullRequestLink({ number, url }: { number: number; url: string }) {
  return (
    <button
      type="button"
      onClick={() => void window.electron.openExternalUrl(url)}
      className="font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
    >
      #{number}
    </button>
  );
}

function ActivityLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px] leading-[1.55] text-[var(--text-primary)]">
      <span className="mt-[3px] flex-shrink-0 text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function PropertyGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <div className="mb-2 text-[13px] text-[var(--text-muted)]">{label}</div>
      {children}
    </div>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2">
      <span className="w-[68px] flex-shrink-0 text-[11.5px] text-[var(--text-muted)]">{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </div>
  );
}

/** Header overflow: only what has no home on the page, destructive last. */
function OverflowMenu({ onRemove }: { onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="More"
        aria-label="More"
        className={`no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] ${
          open ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)]' : ''
        }`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-[224px] rounded-[10px] border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-[var(--error)] transition-colors hover:bg-[var(--sidebar-item-hover)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove from board
            <span className="ml-auto text-[11px] tracking-wide text-[var(--text-muted)]">⌘⌫</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A rail property that opens a small option list beneath it, like Stage. */
function PropertyMenu({
  value,
  placeholder,
  options,
  onSelect,
}: {
  value: string | null;
  placeholder: string;
  options: Array<{ key: string; label: string; title?: string; icon?: ReactNode }>;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const current = options.find((option) => option.key === value) || null;

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((entry) => !entry)}
        title={current?.title}
        className={`-ml-1.5 inline-flex h-[24px] max-w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] transition-colors hover:bg-[var(--sidebar-item-hover)] ${
          current ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
        }`}
      >
        {current?.icon}
        <span className="truncate">{current?.label || placeholder}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-[260px] w-[220px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] py-1 shadow-lg">
          {options.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[12px] text-[var(--text-muted)]">No options</div>
          ) : null}
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              title={option.title}
              onClick={() => {
                onSelect(option.key);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--sidebar-item-hover)] ${
                option.key === value ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.key === value ? (
                <Check className="ml-auto h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StageMenu({
  stage,
  onSetStage,
}: {
  stage: BoardStage;
  onSetStage: (stage: BoardStage) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="-ml-1.5 inline-flex h-[24px] items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)]"
      >
        <StageIcon stage={stage} className="h-3 w-3" />
        {STAGE_META[stage].label}
        <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-[150px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--popover-bg,var(--preview-surface))] py-1 shadow-lg">
          {BOARD_STAGES.map((entry) => {
            return (
              <button
                key={entry}
                type="button"
                onClick={() => {
                  onSetStage(entry);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--sidebar-item-hover)] ${
                  entry === stage ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }`}
              >
                <StageIcon stage={entry} className="h-3 w-3" />
                {STAGE_META[entry].label}
                {entry === stage ? (
                  <Check className="ml-auto h-3 w-3 text-[var(--text-muted)]" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
