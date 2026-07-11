import { useMemo, useState, type DragEvent } from 'react';
import {
  ArrowsSplit,
  FolderClosed,
  FolderOpen,
  MoreHorizontal,
  Pin,
  Plus,
  Trash2,
} from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { allLeaves } from '../store/layout-tree';
import { sendEvent } from '../hooks/useIPC';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import type { AgentProvider, SessionView } from '../types';

type ProjectGroup = {
  key: string;
  label: string;
  fullPath: string | null;
  sessions: SessionView[];
};

const DEFAULT_VISIBLE_SESSIONS_PER_PROJECT = 5;

function getProjectLabel(fullPath: string | null): string {
  return fullPath
    ? fullPath.split('/').filter(Boolean).pop() || fullPath
    : 'No Project';
}

function formatSidebarTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function setSessionDragData(event: DragEvent<HTMLElement>, session: SessionView) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-aegis-session-id', session.id);
  event.dataTransfer.setData('text/plain', session.title);
}

interface ProjectTreeViewProps {
  onSessionClick: (sessionId: string, options?: { preserveSplit?: boolean }) => void;
  onSelectProjectFolder: () => void;
  onNewSessionForProject: (cwd: string, channelId?: string) => void;
  projectCwd: string | null;
}

function ProviderGlyph({ provider: _provider }: { provider?: AgentProvider }) {
  return null;
}

export function FolderTreeView({
  onSessionClick,
  onSelectProjectFolder,
  onNewSessionForProject,
  projectCwd,
}: ProjectTreeViewProps) {
  const {
    sessions,
    activeWorkspace,
    workspaceLayout,
    sidebarSearchQuery,
    setProjectCwd,
  } = useAppStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(
    () => new Set()
  );
  const isChatWorkspaceActive = activeWorkspace === 'chat';

  // Sessions currently mounted in any workspace pane. With recursive tiling
  // there is no single "split pair" — every open session simply renders with the
  // selected/highlight style in the normal thread list.
  const openSessionIds = useMemo(
    () =>
      new Set(
        allLeaves(workspaceLayout.root)
          .map((leaf) => leaf.sessionId)
          .filter((id): id is string => Boolean(id))
      ),
    [workspaceLayout]
  );

  const { pinnedSessions, projectGroups } = useMemo(() => {
    let sessionList = Object.values(sessions).filter(
      (session) => !session.hiddenFromThreads && session.scope !== 'dm'
    );

    if (sidebarSearchQuery.trim()) {
      const query = sidebarSearchQuery.toLowerCase();
      sessionList = sessionList.filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
      );
    }

    const pinnedSessions = sessionList
      .filter((session) => session.pinned)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const regularSessions = sessionList.filter((session) => !session.pinned);
    const grouped = new Map<string, ProjectGroup>();

    for (const session of regularSessions) {
      // 按项目根分组：worktree thread 的 cwd 指向 .worktrees/ 下的检出目录，
      // 用 projectCwd 兜底才不会把它当成一个独立"项目"
      const fullPath = (session.projectCwd || session.cwd)?.trim() || null;
      const key = fullPath || '__no_project__';

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          label: getProjectLabel(fullPath),
          fullPath,
          sessions: [],
        });
      }

      grouped.get(key)!.sessions.push(session);
    }

    const selectedProjectPath = projectCwd?.trim() || null;
    if (selectedProjectPath && !sidebarSearchQuery.trim() && !grouped.has(selectedProjectPath)) {
      grouped.set(selectedProjectPath, {
        key: selectedProjectPath,
        label: getProjectLabel(selectedProjectPath),
        fullPath: selectedProjectPath,
        sessions: [],
      });
    }

    const projectGroups = Array.from(grouped.values())
      .map((group) => ({
        ...group,
        sessions: group.sessions.sort((left, right) => right.updatedAt - left.updatedAt),
      }))
      .sort((left, right) => {
        const leftLatest = left.sessions[0]?.updatedAt || 0;
        const rightLatest = right.sessions[0]?.updatedAt || 0;
        return rightLatest - leftLatest;
      });

    return { pinnedSessions, projectGroups };
  }, [projectCwd, sessions, sidebarSearchQuery]);

  const createDraftSession = useAppStore((s) => s.createDraftSession);

  // 在既有 worktree 里开新对话：新草稿的 cwd 指向同一个隔离检出
  const createDraftSessionInWorktree = (
    worktreePath: string,
    branch: string,
    sample: SessionView | undefined
  ) => {
    createDraftSession(worktreePath, sample?.channelId || null, {
      title: `New Chat - ${branch}`,
      projectCwd: sample?.projectCwd ?? null,
      envMode: 'worktree',
      worktreePath,
      associatedWorktreePath: worktreePath,
      associatedWorktreeBranch: sample?.associatedWorktreeBranch ?? branch,
      associatedWorktreeRef: sample?.associatedWorktreeRef ?? null,
    });
  };

  // 项目本身不是持久实体（由 session 分组推导），"移除项目"= 删除组内全部
  // thread；外部只读会话（claude_remote）删不掉，保留并提示
  const removeProjectGroup = (group: ProjectGroup) => {
    const deletable = group.sessions.filter((session) => session.source !== 'claude_remote');
    const remoteCount = group.sessions.length - deletable.length;

    if (deletable.length > 0) {
      const details = [
        deletable.length === 1
          ? 'This permanently deletes its 1 conversation.'
          : `This permanently deletes all ${deletable.length} conversations in it.`,
      ];
      if (deletable.some((session) => session.status === 'running')) {
        details.push('Running tasks will be stopped.');
      }
      if (remoteCount > 0) {
        details.push(
          `${remoteCount} external Claude ${remoteCount === 1 ? 'session is' : 'sessions are'} read-only and will stay.`
        );
      }
      if (!window.confirm(`Remove "${group.label}" from the list? ${details.join(' ')}`)) {
        return;
      }
      for (const session of deletable) {
        sendEvent({ type: 'session.delete', payload: { sessionId: session.id } });
      }
    }

    // 选中的项目会被强制显示为空分组，清掉选中态它才会真正消失
    if (group.fullPath && projectCwd?.trim() === group.fullPath) {
      setProjectCwd(null);
    }
  };

  const isExpanded = (key: string) => !collapsedGroups.has(key);

  const toggleGroupExpanded = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div>
      {pinnedSessions.length > 0 && (
        <section className="mb-4">
          <div className="mb-1 px-2 text-[11px] font-normal uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Pinned
          </div>
          {pinnedSessions.map((session) => {
            const isSessionActive = isChatWorkspaceActive && openSessionIds.has(session.id);

            return (
              <SessionItem
                key={`pinned:${session.id}`}
                session={session}
                isActive={isSessionActive}
                runtimeBadge={
                  session.runtimeNotice
                    ? session.runtimeNotice
                    : !isSessionActive && session.status === 'running'
                      ? 'running'
                      : null
                }
                depth={0}
                onClick={() => onSessionClick(session.id)}
                onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
              />
            );
          })}
        </section>
      )}

      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="rounded-md px-1 text-[13px] text-[var(--text-primary)] transition-colors">
          Projects
        </div>
        <button
          type="button"
          onClick={() => {
            void onSelectProjectFolder();
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg no-drag text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          aria-label={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
          title={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </div>

      {projectGroups.map((group) => {
        const expanded = isExpanded(group.key);
        const sessionListExpanded = expandedSessionGroups.has(group.key);
        const hasMoreSessions =
          group.sessions.length > DEFAULT_VISIBLE_SESSIONS_PER_PROJECT;
        return (
          <div key={group.key} className="mb-3">
            <div className="group/project flex items-center gap-1 px-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                onClick={() => toggleGroupExpanded(group.key)}
                title={group.fullPath || 'Sessions without a project folder'}
                aria-expanded={expanded}
              >
                {expanded ? <FolderOpen className="w-3.5 h-3.5" /> : <FolderClosed className="w-3.5 h-3.5" />}
                <span className="text-[13px] font-normal truncate flex-1">{group.label}</span>
              </button>

              {group.fullPath && (
                <button
                  type="button"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-all duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] group-hover/project:opacity-100"
                  title={`New thread in ${group.label}`}
                  aria-label={`New thread in ${group.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSessionForProject(group.fullPath!, DEFAULT_WORKSPACE_CHANNEL_ID);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-all duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus:opacity-100 group-hover/project:opacity-100 data-[popup-open]:bg-[var(--sidebar-item-hover)] data-[popup-open]:text-[var(--text-primary)] data-[popup-open]:opacity-100"
                    title={`Options for ${group.label}`}
                    aria-label={`Options for ${group.label}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]">
                  {group.fullPath && (
                    <>
                      <DropdownMenuItem
                        className="gap-2 cursor-pointer"
                        onSelect={() => void window.electron.revealPath(group.fullPath!)}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span>Show in Finder</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    className="gap-2 cursor-pointer text-[var(--error)]"
                    onSelect={() => removeProjectGroup(group)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Remove</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {expanded && (
              <div className="mt-1">
                {group.sessions.length === 0 ? (
                  <div className="ml-4 rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-muted)]">
                    No threads yet
                  </div>
                ) : (
                  (() => {
                    const visibleSessions = sessionListExpanded
                      ? group.sessions
                      : group.sessions.slice(0, DEFAULT_VISIBLE_SESSIONS_PER_PROJECT);
                    // 项目 → worktree（分支）→ threads 的三层结构：worktree thread
                    // 的 cwd 已指向隔离检出，挂在分支小节下如实呈现，而不是提为
                    // 顶层"假项目"或混在项目本体的 thread 里。
                    const regularSessions = visibleSessions.filter(
                      (session) => !(session.envMode === 'worktree' && session.worktreePath)
                    );
                    const worktreeGroups = new Map<string, SessionView[]>();
                    for (const session of visibleSessions) {
                      if (session.envMode === 'worktree' && session.worktreePath) {
                        const list = worktreeGroups.get(session.worktreePath) ?? [];
                        list.push(session);
                        worktreeGroups.set(session.worktreePath, list);
                      }
                    }
                    const renderSession = (session: SessionView, depth: number) => {
                      const isSessionActive =
                        isChatWorkspaceActive && openSessionIds.has(session.id);
                      return (
                        <SessionItem
                          key={session.id}
                          session={session}
                          isActive={isSessionActive}
                          runtimeBadge={
                            session.runtimeNotice
                              ? session.runtimeNotice
                              : !isSessionActive && session.status === 'running'
                                ? 'running'
                                : null
                          }
                          depth={depth}
                          showWorktreeBadge={depth < 2}
                          onClick={() => onSessionClick(session.id)}
                          onTogglePin={() =>
                            sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })
                          }
                        />
                      );
                    };
                    return (
                      <>
                        {regularSessions.map((session) => renderSession(session, 1))}
                        {Array.from(worktreeGroups.entries()).map(([worktreePath, worktreeSessions]) => {
                          const sample = worktreeSessions[0];
                          const branch =
                            worktreeSessions.find((item) => item.associatedWorktreeBranch)
                              ?.associatedWorktreeBranch ||
                            worktreePath.split('/').filter(Boolean).pop() ||
                            'worktree';
                          return (
                            <div key={worktreePath}>
                              <div
                                className="group/worktree ml-4 flex h-6 min-w-0 items-center gap-1.5 px-2 text-[var(--text-muted)]"
                                title={`${branch} · ${worktreePath}`}
                              >
                                <ArrowsSplit className="h-3 w-3 flex-shrink-0" />
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                  {branch}
                                </span>
                                <button
                                  type="button"
                                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md opacity-0 transition-all duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] focus:opacity-100 group-hover/worktree:opacity-100"
                                  title={`New thread in ${branch}`}
                                  aria-label={`New thread in worktree ${branch}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    createDraftSessionInWorktree(worktreePath, branch, sample);
                                  }}
                                >
                                  <Plus className="h-3 w-3" strokeWidth={1.9} />
                                </button>
                              </div>
                              {worktreeSessions.map((session) => renderSession(session, 2))}
                            </div>
                          );
                        })}
                      </>
                    );
                  })()
                )}
                {hasMoreSessions ? (
                  <button
                    type="button"
                    className="ml-8 px-2 py-1.5 text-left text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none"
                    aria-expanded={sessionListExpanded}
                    onClick={() => {
                      setExpandedSessionGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) {
                          next.delete(group.key);
                        } else {
                          next.add(group.key);
                        }
                        return next;
                      });
                    }}
                  >
                    {sessionListExpanded ? 'Show less' : 'Show more'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {projectGroups.length === 0 && pinnedSessions.length === 0 && (
        <div className="text-center text-[var(--text-muted)] py-8 text-[13px]">
          {sidebarSearchQuery ? 'No matching threads' : 'No threads yet'}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isActive,
  runtimeBadge,
  depth,
  onClick,
  onTogglePin,
  showWorktreeBadge = true,
}: {
  session: SessionView;
  isActive: boolean;
  runtimeBadge: 'running' | 'completed' | 'error' | null;
  depth: number;
  onClick: () => void;
  onTogglePin: () => void;
  /** worktree 子分组的分支头已表达归属时，行内徽标可省 */
  showWorktreeBadge?: boolean;
}) {
  const forkSessionToPane = useAppStore((s) => s.forkSessionToPane);
  const createDraftSession = useAppStore((s) => s.createDraftSession);
  const inWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  // Fork branches the provider-side conversation: Claude via the SDK's native
  // fork (bootstrapped from history if needed), Codex via app-server
  // `thread/fork`, OpenCode via the SDK's `session.fork`. Other providers have
  // no fork mechanism yet. The main process returns a friendly error for an
  // empty conversation.
  const providerSupportsFork =
    session.provider === 'claude' || session.provider === 'codex' || session.provider === 'opencode';
  const canFork = !session.isDraft && providerSupportsFork;
  const canMoveToWorktree =
    !session.isDraft && session.envMode !== 'worktree' && session.status !== 'running';
  const forkLabel = canFork
    ? 'Fork into a new pane'
    : providerSupportsFork
      ? 'Fork into a new pane (send a message first)'
      : 'Fork into a new pane (not supported for this provider)';

  const handleContextMenu = async (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const result = await window.electron.showNativeMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: 'fork',
          label: forkLabel,
          enabled: canFork,
        },
        // worktree 内外互斥的两个动作：在外可以搬进去，在内可以再开一条
        ...(inWorktree
          ? [
              {
                id: 'new-in-worktree',
                label: `New thread in this worktree${
                  session.associatedWorktreeBranch ? ` (${session.associatedWorktreeBranch})` : ''
                }`,
              },
            ]
          : [
              {
                id: 'move-worktree',
                // 不 fork 对话、provider 无关：同一条 thread 挪进隔离 worktree 继续
                label: canMoveToWorktree
                  ? 'Move into a new worktree'
                  : 'Move into a new worktree (agent is running)',
                enabled: canMoveToWorktree,
              },
            ]),
        { id: 'sep', type: 'separator' },
        { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin' },
        { id: 'sep2', type: 'separator' },
        { id: 'delete', label: 'Delete' },
      ],
    });
    if (!result.ok || !result.id) return;
    if (result.id === 'fork') {
      void forkSessionToPane(session.id);
    } else if (result.id === 'new-in-worktree') {
      if (session.worktreePath) {
        createDraftSession(session.worktreePath, session.channelId || null, {
          title: `New Chat - ${session.associatedWorktreeBranch || 'Worktree'}`,
          projectCwd: session.projectCwd ?? null,
          envMode: 'worktree',
          worktreePath: session.worktreePath,
          associatedWorktreePath: session.worktreePath,
          associatedWorktreeBranch: session.associatedWorktreeBranch ?? null,
          associatedWorktreeRef: session.associatedWorktreeRef ?? null,
        });
      }
    } else if (result.id === 'move-worktree') {
      void (async () => {
        const result = await window.electron.moveSessionToWorktree(session.id);
        if (result.ok) {
          toast.success('Thread moved into a new worktree — changes stay on its own branch.');
        } else {
          toast.error(result.message || 'Could not move the thread into a worktree.');
        }
      })();
    } else if (result.id === 'pin') {
      onTogglePin();
    } else if (result.id === 'delete') {
      const detail = session.status === 'running' ? ' The running task will be stopped.' : '';
      if (window.confirm(`Delete "${session.title}"? This permanently removes the conversation.${detail}`)) {
        sendEvent({ type: 'session.delete', payload: { sessionId: session.id } });
      }
    }
  };

  return (
    <div
      onContextMenu={handleContextMenu}
      className={`group/session relative cursor-pointer rounded-lg py-1.5 pl-8 pr-3 transition-colors duration-150 ${
        isActive
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      style={{
        marginLeft: `${depth * 16}px`,
        marginBottom: '3px',
      }}
      draggable
      onDragStart={(event) => {
        setSessionDragData(event, session);
      }}
      onClick={onClick}
    >
      <button
        type="button"
        draggable={false}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
        }}
        className={`absolute left-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-all duration-150 hover:text-[var(--text-primary)] focus:opacity-100 group-hover/session:opacity-100 ${
          session.pinned ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
        }`}
        aria-label={session.pinned ? 'Unpin conversation' : 'Pin conversation'}
        aria-pressed={session.pinned}
        title={session.pinned ? 'Unpin conversation' : 'Pin conversation'}
      >
        <Pin className="h-3.5 w-3.5" fill={session.pinned ? 'currentColor' : 'none'} />
      </button>

      <div className="flex min-h-[22px] items-center gap-2">
        <span className="flex-1 truncate text-[13px] font-normal leading-[1.3]">{session.title}</span>
        {showWorktreeBadge && session.envMode === 'worktree' && session.worktreePath ? (
          <span
            className="flex-shrink-0"
            title={`Runs in a worktree${session.associatedWorktreeBranch ? ` · ${session.associatedWorktreeBranch}` : ''}`}
          >
            <ArrowsSplit className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-label="Runs in a worktree" />
          </span>
        ) : null}
        <span className="flex-shrink-0 text-[12px] text-[var(--text-muted)]">
          {formatSidebarTime(session.updatedAt)}
        </span>
        {runtimeBadge && (
          <span
            className={`status-dot ${runtimeBadge} flex-shrink-0`}
            title={
              runtimeBadge === 'running'
                ? 'Session is running'
                : runtimeBadge === 'completed'
                  ? 'Session completed'
                  : 'Session failed'
            }
            aria-label={
              runtimeBadge === 'running'
                ? 'Session is running'
                : runtimeBadge === 'completed'
                  ? 'Session completed'
                  : 'Session failed'
            }
          />
        )}
      </div>
    </div>
  );
}

function SplitSessionRow({
  primary,
  secondary,
  activePaneId,
  isActive,
  depth,
  onOpenPrimary,
  onOpenSecondary,
}: {
  primary: SessionView;
  secondary: SessionView;
  activePaneId: 'primary' | 'secondary';
  isActive: boolean;
  depth: number;
  onOpenPrimary: () => void;
  onOpenSecondary: () => void;
}) {
  const rowBase =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors';

  return (
    <div
      className="group relative overflow-hidden rounded-md"
      style={{
        marginLeft: `${depth * 16}px`,
        marginBottom: '4px',
      }}
    >
      <button
        type="button"
        onClick={onOpenPrimary}
        className={`${rowBase} ${
          isActive && activePaneId === 'primary'
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          left
        </span>
        <ProviderGlyph provider={primary.provider} />
        <span className="min-w-0 flex-1 truncate font-normal">{primary.title}</span>
      </button>
      <button
        type="button"
        onClick={onOpenSecondary}
        className={`${rowBase} border-t border-[var(--border)] ${
          isActive && activePaneId === 'secondary'
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          right
        </span>
        <ProviderGlyph provider={secondary.provider} />
        <span className="min-w-0 flex-1 truncate font-normal">{secondary.title}</span>
      </button>
    </div>
  );
}
