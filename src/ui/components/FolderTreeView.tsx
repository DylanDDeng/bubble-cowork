import { useMemo, useState, type DragEvent } from 'react';
import {
  FolderClosed,
  FolderOpen,
  Pin,
  Plus,
} from './icons';
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
  } = useAppStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
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
      (session) =>
        !session.hiddenFromThreads &&
        session.scope !== 'dm'
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
      const fullPath = session.cwd?.trim() || null;
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
            </div>

            {expanded && (
              <div className="mt-1">
                {group.sessions.length === 0 ? (
                  <div className="ml-4 rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-muted)]">
                    No threads yet
                  </div>
                ) : (
                  group.sessions.map((session) => {
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
                        depth={1}
                        onClick={() => onSessionClick(session.id)}
                        onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
                      />
                    );
                  })
                )}
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
}: {
  session: SessionView;
  isActive: boolean;
  runtimeBadge: 'running' | 'completed' | 'error' | null;
  depth: number;
  onClick: () => void;
  onTogglePin: () => void;
}) {
  const forkSessionToPane = useAppStore((s) => s.forkSessionToPane);
  // Fork branches a Claude conversation. The resumable session id isn't always
  // persisted (the app can rebuild from history), so gate only on a non-draft
  // Claude session; the main process bootstraps a fork point if needed and
  // returns a friendly error for an empty conversation.
  const canFork = !session.isDraft && session.provider === 'claude';

  const handleContextMenu = async (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const result = await window.electron.showNativeMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { id: 'fork', label: 'Fork into a new pane', enabled: canFork },
        { id: 'sep', type: 'separator' },
        { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin' },
        { id: 'sep2', type: 'separator' },
        { id: 'delete', label: 'Delete' },
      ],
    });
    if (!result.ok || !result.id) return;
    if (result.id === 'fork') {
      void forkSessionToPane(session.id);
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
