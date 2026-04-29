import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FolderClosed, FolderOpen, MoreVertical, Pin, Copy, Trash2, SquarePen } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { AgentProvider, SessionView } from '../types';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';

type ProjectGroup = {
  key: string;
  label: string;
  fullPath: string | null;
  sessions: SessionView[];
};

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
  onSessionDelete: (sessionId: string) => void;
  onCopyResume: (session: SessionView) => void;
  onSelectProjectFolder: () => void;
  onNewSessionForProject: (cwd: string) => void;
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
  onSessionDelete,
  onCopyResume,
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
    sidebarSearchQuery,
  } = useAppStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

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
        });
      }

      grouped.get(key)!.sessions.push(session);
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
  }, [sessions, sidebarSearchQuery, splitPair]);

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
                onDelete={() => onSessionDelete(session.id)}
                onCopyResume={() => onCopyResume(session)}
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
                  title={`Start a new thread in ${group.label}`}
                  aria-label={`Start a new thread in ${group.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSessionForProject(group.fullPath);
                  }}
                >
                  <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
                </button>
              )}
            </div>

            {expanded &&
              group.sessions.map((session) => {
                if (splitPair && session.id === splitPair.primary.id) {
                  return (
                    <SplitSessionRow
                      key={`split:${splitPair.primary.id}:${splitPair.secondary.id}`}
                      primary={splitPair.primary}
                      secondary={splitPair.secondary}
                      activePaneId={activePaneId}
                      depth={1}
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
                    depth={1}
                    onClick={() => onSessionClick(session.id)}
                    onDelete={() => onSessionDelete(session.id)}
                    onCopyResume={() => onCopyResume(session)}
                    onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
                  />
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

function SessionItem({
  session,
  isActive,
  runtimeBadge,
  depth,
  onClick,
  onDelete,
  onCopyResume,
  onTogglePin,
}: {
  session: SessionView;
  isActive: boolean;
  runtimeBadge: 'running' | 'completed' | 'error' | null;
  depth: number;
  onClick: () => void;
  onDelete: () => void;
  onCopyResume: () => void;
  onTogglePin: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenuActions = !!session.claudeSessionId || session.readOnly !== true;

  return (
    <div
      className={`group/session relative cursor-pointer rounded-lg py-1.5 pl-8 pr-3 transition-colors duration-150 ${
        isActive
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
          : menuOpen
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

      <div className="flex min-h-[22px] items-center gap-2 pr-8">
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

      {hasMenuActions && (
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              className={`absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition-all duration-150 hover:bg-[var(--bg-tertiary)] ${
                menuOpen ? 'opacity-100' : 'opacity-0 group-hover/session:opacity-100'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="popover-surface z-50 min-w-[160px] p-1.5"
              sideOffset={5}
            >
              {session.claudeSessionId && (
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-[13px] rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150"
                  onClick={onCopyResume}
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy Resume Command
                </DropdownMenu.Item>
              )}
              {session.claudeSessionId && session.readOnly !== true && (
                <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
              )}
              {session.readOnly !== true && (
                <DropdownMenu.Item
                  className="flex items-center gap-2 px-3 py-2 text-[13px] rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 text-red-400"
                  onClick={onDelete}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
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
