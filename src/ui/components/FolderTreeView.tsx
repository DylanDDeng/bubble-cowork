import { useMemo, useState } from 'react';
import { Check, FolderClosed, FolderOpen, Hash, Pin, Plus, SquarePen, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { DEFAULT_WORKSPACE_CHANNEL_ID, type WorkspaceChannel } from '../../shared/types';
import type { AgentProvider, SessionView } from '../types';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';

type ProjectGroup = {
  key: string;
  label: string;
  fullPath: string | null;
  sessions: SessionView[];
  channels: ChannelGroup[];
};

type ChannelGroup = {
  id: string;
  name: string;
  sessions: SessionView[];
};

function getProjectKey(cwd?: string | null): string {
  return cwd?.trim() || '__no_project__';
}

function createDefaultChannel(projectCwd?: string | null): WorkspaceChannel {
  const now = Date.now();
  return {
    id: DEFAULT_WORKSPACE_CHANNEL_ID,
    projectCwd: projectCwd?.trim() || '',
    name: 'all',
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultChannel(
  channels: WorkspaceChannel[] | undefined,
  projectCwd?: string | null
): WorkspaceChannel[] {
  const existing = channels || [];
  if (existing.some((channel) => channel.id === DEFAULT_WORKSPACE_CHANNEL_ID)) {
    return existing;
  }
  return [createDefaultChannel(projectCwd), ...existing];
}

type SplitPairState = {
  primary: SessionView;
  secondary: SessionView;
};

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

interface ProjectTreeViewProps {
  onSessionClick: (sessionId: string, options?: { preserveSplit?: boolean }) => void;
  onSelectProjectFolder: () => void;
  onNewSessionForProject: (cwd: string, channelId?: string) => void;
  projectCwd: string | null;
}

function ProviderGlyph({ provider }: { provider?: AgentProvider }) {
  if (provider === 'codex') {
    return (
      <img
        src={openaiLogo}
        alt=""
        aria-hidden="true"
        className="h-3.5 w-3.5 flex-shrink-0 opacity-80"
      />
    );
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className="h-3.5 w-3.5 flex-shrink-0 opacity-80" />;
  }

  return (
    <img
      src={claudeLogo}
      alt=""
      aria-hidden="true"
      className="h-3.5 w-3.5 flex-shrink-0 opacity-85"
    />
  );
}

export function FolderTreeView({
  onSessionClick,
  onSelectProjectFolder,
  onNewSessionForProject,
  projectCwd,
}: ProjectTreeViewProps) {
  const {
    sessions,
    activeSessionId,
    activePaneId,
    savedSplitVisible,
    setChatLayoutMode,
    chatPanes,
    setActivePane,
    workspaceChannelsByProject,
    createWorkspaceChannel,
    setActiveChannelForProject,
    setSessionChannel,
    setProjectCwd,
    activeChannelByProject,
    sidebarSearchQuery,
  } = useAppStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [channelDraftProjectKey, setChannelDraftProjectKey] = useState<string | null>(null);
  const [channelDraftName, setChannelDraftName] = useState('');
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeProjectKey = activeSession?.cwd?.trim() || projectCwd?.trim() || '__no_project__';

  const splitPair = useMemo<SplitPairState | null>(() => {
    if (!savedSplitVisible) {
      return null;
    }

    const primarySessionId = chatPanes.primary.sessionId;
    const secondarySessionId = chatPanes.secondary.sessionId;
    if (!primarySessionId || !secondarySessionId || primarySessionId === secondarySessionId) {
      return null;
    }

    const primary = sessions[primarySessionId];
    const secondary = sessions[secondarySessionId];
    if (!primary || !secondary || primary.hiddenFromThreads || secondary.hiddenFromThreads) {
      return null;
    }

    return { primary, secondary };
  }, [savedSplitVisible, chatPanes.primary.sessionId, chatPanes.secondary.sessionId, sessions]);

  const { pinnedSessions, projectGroups } = useMemo(() => {
    let sessionList = Object.values(sessions).filter(
      (session) => !session.hiddenFromThreads && session.source !== 'claude_code'
    );

    if (splitPair) {
      const hiddenIds = new Set([splitPair.secondary.id]);
      sessionList = sessionList.filter((session) => !hiddenIds.has(session.id));
    }

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
        const label = fullPath
          ? fullPath.split('/').filter(Boolean).pop() || fullPath
          : 'No Project';

        grouped.set(key, {
          key,
          label,
          fullPath,
          sessions: [],
          channels: [],
        });
      }

      grouped.get(key)!.sessions.push(session);
    }

    const projectGroups = Array.from(grouped.values())
      .map((group) => {
        const sortedSessions = group.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
        const configuredChannels = ensureDefaultChannel(
          workspaceChannelsByProject[group.key],
          group.fullPath
        );
        const channels = new Map<string, ChannelGroup>();
        for (const channel of configuredChannels) {
          channels.set(channel.id, {
            id: channel.id,
            name: channel.name,
            sessions: [],
          });
        }

        for (const session of sortedSessions) {
          const channelId = session.channelId?.trim() || DEFAULT_WORKSPACE_CHANNEL_ID;
          if (!channels.has(channelId)) {
            channels.set(channelId, {
              id: channelId,
              name: channelId,
              sessions: [],
            });
          }
          channels.get(channelId)!.sessions.push(session);
        }

        return {
          ...group,
          sessions: sortedSessions,
          channels: Array.from(channels.values()).sort((left, right) => {
            if (left.id === DEFAULT_WORKSPACE_CHANNEL_ID) return -1;
            if (right.id === DEFAULT_WORKSPACE_CHANNEL_ID) return 1;
            const leftLatest = left.sessions[0]?.updatedAt || 0;
            const rightLatest = right.sessions[0]?.updatedAt || 0;
            return rightLatest - leftLatest;
          }),
        };
      })
      .sort((left, right) => {
        const leftLatest = left.sessions[0]?.updatedAt || 0;
        const rightLatest = right.sessions[0]?.updatedAt || 0;
        return rightLatest - leftLatest;
      });

    return { pinnedSessions, projectGroups };
  }, [sessions, sidebarSearchQuery, splitPair, workspaceChannelsByProject]);

  const startChannelDraft = (group: ProjectGroup) => {
    setChannelDraftProjectKey(group.key);
    setChannelDraftName('');
    if (group.fullPath) {
      setProjectCwd(group.fullPath);
    }
  };

  const cancelChannelDraft = () => {
    setChannelDraftProjectKey(null);
    setChannelDraftName('');
  };

  const submitChannelDraft = (group: ProjectGroup) => {
    const nextChannelId = createWorkspaceChannel(group.fullPath || '', channelDraftName);
    if (!nextChannelId) {
      return;
    }
    if (group.fullPath) {
      setProjectCwd(group.fullPath);
    }
    setActiveChannelForProject(group.fullPath || '', nextChannelId);
    if (group.fullPath) {
      onNewSessionForProject(group.fullPath, nextChannelId);
    }
    cancelChannelDraft();
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
          <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Pinned
          </div>
          {pinnedSessions.map((session) => {
            const isSessionActive = activeSessionId === session.id;

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
                <span className="text-[13px] font-medium truncate flex-1">{group.label}</span>
              </button>

              {group.fullPath && (
                <button
                  type="button"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-all duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] group-hover/project:opacity-100"
                  title={`Create channel in ${group.label}`}
                  aria-label={`Create channel in ${group.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    startChannelDraft(group);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              )}
            </div>

            {expanded && channelDraftProjectKey === group.key && (
              <form
                className="mb-1 ml-4 flex h-8 items-center gap-1 rounded-lg bg-[var(--bg-secondary)] px-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitChannelDraft(group);
                }}
              >
                <Hash className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                <input
                  autoFocus
                  value={channelDraftName}
                  onChange={(event) => setChannelDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelChannelDraft();
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  placeholder="new-channel"
                  aria-label="Channel name"
                />
                <button
                  type="submit"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Create channel"
                  title="Create channel"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={cancelChannelDraft}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Cancel"
                  title="Cancel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            )}

            {expanded &&
              group.channels.map((channel) => {
                const activeChannelId =
                  activeChannelByProject[group.key] || DEFAULT_WORKSPACE_CHANNEL_ID;
                const isChannelActive =
                  activeChannelId === channel.id && activeProjectKey === group.key;

                return (
                  <div key={`${group.key}:${channel.id}`}>
                    <ChannelItem
                      channel={channel}
                      depth={1}
                      isActive={isChannelActive}
                      onNewSession={() => {
                        if (!group.fullPath) {
                          return;
                        }
                        setActiveChannelForProject(group.fullPath, channel.id);
                        setProjectCwd(group.fullPath);
                        onNewSessionForProject(group.fullPath, channel.id);
                      }}
                      onDropSession={(sessionId) => {
                        const draggedSession = sessions[sessionId];
                        if (!draggedSession || getProjectKey(draggedSession.cwd) !== group.key) {
                          return;
                        }
                        setSessionChannel(sessionId, channel.id);
                        sendEvent({
                          type: 'session.setChannel',
                          payload: { sessionId, channelId: channel.id },
                        });
                      }}
                      onClick={() => {
                        setActiveChannelForProject(group.fullPath || '', channel.id);
                        if (group.fullPath) {
                          setProjectCwd(group.fullPath);
                        }
                        const latestSession = channel.sessions[0];
                        if (latestSession) {
                          onSessionClick(latestSession.id);
                        } else if (group.fullPath) {
                          onNewSessionForProject(group.fullPath, channel.id);
                        }
                      }}
                    />

                    {channel.sessions.map((session) => {
                      if (splitPair && session.id === splitPair.primary.id) {
                        return (
                          <SplitSessionRow
                            key={`split:${splitPair.primary.id}:${splitPair.secondary.id}`}
                            primary={splitPair.primary}
                            secondary={splitPair.secondary}
                            activePaneId={activePaneId}
                            depth={2}
                            onOpenPrimary={() => {
                              setChatLayoutMode('split');
                              setActivePane('primary');
                            }}
                            onOpenSecondary={() => {
                              setChatLayoutMode('split');
                              setActivePane('secondary');
                            }}
                          />
                        );
                      }

                      const isSessionActive = activeSessionId === session.id;

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
                          depth={2}
                          onClick={() => onSessionClick(session.id)}
                          onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
                        />
                      );
                    })}
                  </div>
                );
              })}
          </div>
        );
      })}

      {projectGroups.length === 0 && pinnedSessions.length === 0 && (
        <div className="text-center text-[var(--text-muted)] py-8 text-[13px]">
          {sidebarSearchQuery ? 'No matching sessions' : 'No sessions yet'}
        </div>
      )}
    </div>
  );
}

function ChannelItem({
  channel,
  depth,
  isActive,
  onNewSession,
  onDropSession,
  onClick,
}: {
  channel: ChannelGroup;
  depth: number;
  isActive: boolean;
  onNewSession: () => void;
  onDropSession: (sessionId: string) => void;
  onClick: () => void;
}) {
  const runningCount = channel.sessions.filter((session) => session.status === 'running').length;
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-aegis-session-id')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(event) => {
        const sessionId = event.dataTransfer.getData('application/x-aegis-session-id');
        setIsDragOver(false);
        if (!sessionId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onDropSession(sessionId);
      }}
      className={`group/channel mb-1 flex h-7 w-[calc(100%-4px)] min-w-0 items-center gap-1 rounded-lg pr-1 no-drag transition-colors duration-150 ${
        isDragOver
          ? 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
          : isActive
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      style={{ marginLeft: `${depth * 16}px` }}
      title={`# ${channel.name}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
        aria-label={`Open # ${channel.name}`}
      >
        <Hash className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{channel.name}</span>
        {runningCount > 0 && (
          <span className="rounded-full bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
            {runningCount}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNewSession();
        }}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition-opacity duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] group-hover/channel:opacity-100 focus:opacity-100"
        aria-label={`New chat in # ${channel.name}`}
        title={`New chat in # ${channel.name}`}
      >
        <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
      </button>
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
  return (
    <div
      className={`group/session relative cursor-pointer rounded-lg py-1.5 pl-8 pr-3 transition-colors duration-150 ${
        isActive
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      style={{
        marginLeft: `${depth * 16}px`,
        marginBottom: '3px',
      }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-aegis-session-id', session.id);
        event.dataTransfer.setData('text/plain', session.title);
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
        <span className="flex-1 truncate text-[13px] font-medium leading-[1.3]">{session.title}</span>
        {session.source === 'claude_code' && (
          <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            Claude Code
          </span>
        )}
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
  depth,
  onOpenPrimary,
  onOpenSecondary,
}: {
  primary: SessionView;
  secondary: SessionView;
  activePaneId: 'primary' | 'secondary';
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
          activePaneId === 'primary'
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          left
        </span>
        <ProviderGlyph provider={primary.provider} />
        <span className="min-w-0 flex-1 truncate font-medium">{primary.title}</span>
      </button>
      <button
        type="button"
        onClick={onOpenSecondary}
        className={`${rowBase} border-t border-[var(--border)] ${
          activePaneId === 'secondary'
            ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          right
        </span>
        <ProviderGlyph provider={secondary.provider} />
        <span className="min-w-0 flex-1 truncate font-medium">{secondary.title}</span>
      </button>
    </div>
  );
}
