import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleX,
  Clock,
  ExternalLink,
  FileDiff,
  Folder,
  GitBranch,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  User,
} from './icons';
import { AgentIcon } from './ComposerAgentControls';
import { MDContent } from '../render/markdown';
import { useUserProfile } from '../hooks/useUserProfile';
import { avatarColorFor, initialsOf } from '../utils/user-avatar';
import { useAppStore } from '../store/useAppStore';
import {
  BOARD_STAGES,
  latestTaskSession,
  type BoardStage,
  type BoardTask,
} from '../store/useBoardStore';
import {
  STAGE_META,
  StageIcon,
  modelDisplayLabel,
  projectName,
  providerLabel,
  relativeTime,
} from './board-support';
import { extractToolChangeRecords } from '../utils/change-records';
import type { SessionView } from '../types';

export function BoardTaskDetail({
  task,
  sessions,
  orderedTaskIds,
  onBack,
  onSelectTask,
  onOpenSession,
  onSetStage,
  onRename,
  onUpdatePrompt,
  onStart,
  onContinue,
  onEdit,
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
  onUpdatePrompt: (prompt: string) => void;
  onStart: () => void;
  /** Send a follow-up prompt to the latest run. Returns false if it could not send. */
  onContinue: (prompt: string) => boolean;
  onEdit: () => void;
}) {
  const requestSessionHydration = useAppStore((state) => state.requestSessionHydration);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(task.prompt);
  const [followUp, setFollowUp] = useState('');
  const followUpRef = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  // The title is a wrapping textarea so long titles show in full; keep its
  // height matched to the content.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [titleDraft]);

  useEffect(() => {
    setTitleDraft(task.title);
    setPromptDraft(task.prompt);
    setEditingPrompt(false);
  }, [task.id, task.title, task.prompt]);

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

  // A description only counts when it says something the conversation's
  // opening message doesn't — identical text is just the message echoed back,
  // which belongs in the Activity timeline, not up here.
  const firstSession = task.sessionIds.length > 0 ? sessions[task.sessionIds[0]] : null;
  const firstRunPrompt = useMemo(() => {
    if (!firstSession?.hydrated) return null;
    const first = firstSession.messages.find((message) => message.type === 'user_prompt');
    return first && first.type === 'user_prompt' ? first.prompt : null;
  }, [firstSession?.hydrated, firstSession?.messages]);
  const hasDistinctDescription =
    Boolean(task.prompt.trim()) &&
    (firstRunPrompt === null || task.prompt.trim() !== firstRunPrompt.trim());

  const latest = latestTaskSession(task, sessions);
  const taskIndex = orderedTaskIds.indexOf(task.id);
  const prevTaskId = taskIndex > 0 ? orderedTaskIds[taskIndex - 1] : null;
  const nextTaskId =
    taskIndex >= 0 && taskIndex < orderedTaskIds.length - 1 ? orderedTaskIds[taskIndex + 1] : null;

  const latestRunning = latest?.status === 'running' || latest?.status === 'stopping';
  const provider = latest?.provider || task.sessionConfig.provider;
  const model = latest?.model || task.sessionConfig.model;
  const branch = latest?.associatedWorktreeBranch || null;

  const commitTitle = () => {
    if (titleDraft.trim() && titleDraft.trim() !== task.title) onRename(titleDraft);
    else setTitleDraft(task.title);
  };

  const commitPrompt = () => {
    setEditingPrompt(false);
    if (promptDraft.trim() !== task.prompt) onUpdatePrompt(promptDraft);
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
          Board
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
            <div className="mr-auto w-full max-w-[720px] px-8 pb-6 pt-7">
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

              {editingPrompt ? (
                <textarea
                  autoFocus
                  value={promptDraft}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  onBlur={commitPrompt}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setPromptDraft(task.prompt);
                      setEditingPrompt(false);
                    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      commitPrompt();
                    }
                  }}
                  className="mt-3 min-h-[120px] w-full resize-y rounded-[10px] border border-[var(--border-focus)] bg-[var(--bg-secondary)] px-3.5 py-3 text-[13px] leading-[1.6] text-[var(--text-primary)] outline-none"
                  aria-label="Task description"
                />
              ) : hasDistinctDescription ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditingPrompt(true)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setEditingPrompt(true);
                  }}
                  className="group mt-3 cursor-text whitespace-pre-wrap rounded-[10px] px-3.5 py-3 text-[13px] leading-[1.6] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]"
                >
                  {task.prompt}
                  <Pencil className="ml-2 inline h-3 w-3 align-baseline text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingPrompt(true)}
                  className="mt-3 w-full rounded-[10px] border border-dashed border-[var(--border)] px-3.5 py-3 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                  Add a description — what should the agent do, and how do you want it verified?
                </button>
              )}

              <div className="mt-8 border-t border-[var(--border)] pt-5">
                <div className="mb-3 text-[13px] text-[var(--text-muted)]">Activity</div>
                {task.sessionIds.length === 0 ? (
                  <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                    No runs yet. Starting this task creates a new session
                    {task.projectCwd ? ` in ${projectName(task.projectCwd)}` : ''} and its activity
                    shows up here.
                  </p>
                ) : (
                  <div className="space-y-5">
                    {task.sessionIds.map((sessionId, index) => (
                      <RunActivity
                        key={sessionId}
                        session={sessions[sessionId] || null}
                        runNumber={index + 1}
                        showRunNumber={task.sessionIds.length > 1}
                        skipInitialPrompt={index === 0 && hasDistinctDescription}
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex-shrink-0 px-8 pb-5 pt-2">
            <div className="mr-auto w-full max-w-[720px]">
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
                  <button
                    type="button"
                    onClick={() => latest && onOpenSession(latest.id)}
                    className="ml-auto text-[12px] font-medium text-[var(--text-primary)] hover:underline"
                  >
                    Open session to steer
                  </button>
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
              <span
                className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]"
                title={task.projectCwd || undefined}
              >
                <Folder className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{projectName(task.projectCwd)}</span>
              </span>
            </PropertyRow>
            <PropertyRow label="Agent">
              {provider ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]">
                  <AgentIcon provider={provider} />
                  <span className="truncate">{providerLabel(provider)}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onEdit}
                  className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Choose…
                </button>
              )}
            </PropertyRow>
            {model ? (
              <PropertyRow label="Model">
                <span className="truncate text-[12px] text-[var(--text-primary)]" title={model}>
                  {modelDisplayLabel(provider, model) || model}
                </span>
              </PropertyRow>
            ) : null}
            {branch ? (
              <PropertyRow label="Branch">
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-primary)]"
                  title={branch}
                >
                  <GitBranch className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{branch}</span>
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

          {task.sessionIds.length > 1 ? (
            <PropertyGroup label="Runs">
              <div className="space-y-0.5">
                {[...task.sessionIds].reverse().map((sessionId, index) => {
                  const session = sessions[sessionId];
                  const runNumber = task.sessionIds.length - index;
                  return (
                    <button
                      key={sessionId}
                      type="button"
                      disabled={!session}
                      onClick={() => session && onOpenSession(sessionId)}
                      className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--sidebar-item-hover)] disabled:cursor-default disabled:opacity-50"
                    >
                      {session?.provider ? <AgentIcon provider={session.provider} /> : null}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                        Run {runNumber}
                      </span>
                      {session ? (
                        <ExternalLink className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </PropertyGroup>
          ) : null}

          {latest ? (
            <div className="mt-8">
              <RailButton onClick={() => onOpenSession(latest.id)}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open Session
              </RailButton>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/**
 * One run's slice of the activity timeline: who ran, the follow-ups you sent,
 * what changed on disk, and how it ended — derived from the session's
 * hydrated message history.
 */
function RunActivity({
  session,
  runNumber,
  showRunNumber,
  skipInitialPrompt,
  onOpenSession,
}: {
  session: SessionView | null;
  runNumber: number;
  showRunNumber: boolean;
  /** True when the run's first prompt IS the task description shown above. */
  skipInitialPrompt: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const profileName = useUserProfile()?.displayName || null;

  const changeSummary = useMemo(() => {
    if (!session?.hydrated) return null;
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
  }, [session?.hydrated, session?.messages]);

  // A chronological mini-transcript: every follow-up you sent, and the
  // agent's closing text for each turn. Built from message order, never from
  // session status — earlier turns must not vanish when a new one starts.
  const timeline = useMemo(() => {
    if (!session?.hydrated) return [];
    const items: Array<{ kind: 'user' | 'agent'; text: string; time?: number }> = [];
    let pendingAgent: { text: string; time?: number } | null = null;
    let promptCount = 0;
    for (const message of session.messages) {
      if (message.type === 'user_prompt') {
        if (pendingAgent) {
          items.push({ kind: 'agent', ...pendingAgent });
          pendingAgent = null;
        }
        promptCount += 1;
        if (promptCount > 1 || !skipInitialPrompt) {
          items.push({ kind: 'user', text: message.prompt, time: message.createdAt });
        }
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
  }, [session?.hydrated, session?.messages, skipInitialPrompt]);

  if (!session) {
    return (
      <div className="text-[12.5px] text-[var(--text-muted)]">
        {showRunNumber ? `Run ${runNumber} — ` : ''}session no longer available.
      </div>
    );
  }

  const running = session.status === 'running' || session.status === 'stopping';
  const needsPermission = running && session.permissionRequests.length > 0;

  return (
    // A comment-style conversation timeline, flush with the "Activity"
    // heading: each message is a block with an avatar + name header.
    <div className="space-y-4">
      {showRunNumber ? (
        <div className="text-[11px] font-medium text-[var(--text-muted)]">Run {runNumber}</div>
      ) : null}
      {!session.hydrated ? (
        <ActivityLine icon={<Loader2 className="h-3 w-3 animate-spin" />}>
          Loading activity…
        </ActivityLine>
      ) : (
        <>
            {/* Comment-style blocks: avatar + name header, content full-width below. */}
            {timeline.map((item, index) => (
              <div key={index}>
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
            ) : null}
            {needsPermission ? (
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
            ) : null}
            {session.status === 'error' ? (
              <ActivityLine icon={<CircleX className="h-3 w-3 text-[var(--error)]" />}>
                <span className="text-[var(--error)]">The run failed.</span>
              </ActivityLine>
            ) : null}
        </>
      )}
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

function RailButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
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
