import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FolderClosed, FolderOpen, MoreVertical, Pin, Copy, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { StatusIcon } from './StatusIcon';
import { StatusMenu } from './StatusMenu';
import type { SessionView, StatusConfig } from '../types';

type ProjectGroup = {
  key: string;
  label: string;
  fullPath: string | null;
  sessions: SessionView[];
};

interface ProjectTreeViewProps {
  onSessionClick: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onCopyResume: (session: SessionView) => void;
}

export function FolderTreeView({
  onSessionClick,
  onSessionDelete,
  onCopyResume,
}: ProjectTreeViewProps) {
  const {
    sessions,
    activeSessionId,
    sidebarSearchQuery,
    statusFilter,
    statusConfigs,
  } = useAppStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const projectGroups = useMemo(() => {
    let sessionList = Object.values(sessions);

    // 搜索过滤
    if (sidebarSearchQuery.trim()) {
      const query = sidebarSearchQuery.toLowerCase();
      sessionList = sessionList.filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
      );
    }

    // 状态过滤
    if (statusFilter !== 'all') {
      if (statusFilter === 'open') {
        const openIds = new Set(statusConfigs.filter(s => s.category === 'open').map(s => s.id));
        sessionList = sessionList.filter(s => openIds.has(s.todoState || 'todo'));
      } else if (statusFilter === 'closed') {
        const closedIds = new Set(statusConfigs.filter(s => s.category === 'closed').map(s => s.id));
        sessionList = sessionList.filter(s => closedIds.has(s.todoState || 'todo'));
      } else {
        sessionList = sessionList.filter(s => (s.todoState || 'todo') === statusFilter);
      }
    }

    const grouped = new Map<string, ProjectGroup>();

    for (const session of sessionList) {
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

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        sessions: group.sessions.sort((left, right) => right.updatedAt - left.updatedAt),
      }))
      .sort((left, right) => {
        const leftLatest = left.sessions[0]?.updatedAt || 0;
        const rightLatest = right.sessions[0]?.updatedAt || 0;
        return rightLatest - leftLatest;
      });
  }, [sessions, sidebarSearchQuery, statusFilter, statusConfigs]);

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
      {projectGroups.map((group) => {
        const expanded = isExpanded(group.key);
        return (
          <div key={group.key}>
            <button
              type="button"
              className="flex w-full select-none items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-[#EEEEEE]"
              onClick={() => toggleGroupExpanded(group.key)}
              title={group.fullPath || 'Sessions without a project folder'}
              aria-expanded={expanded}
            >
              {expanded ? <FolderOpen className="w-3.5 h-3.5" /> : <FolderClosed className="w-3.5 h-3.5" />}
              <span className="text-sm font-medium truncate flex-1">{group.label}</span>
              <span className="text-xs text-[var(--text-muted)]">{group.sessions.length}</span>
            </button>

            {expanded && group.fullPath && (
              <div className="px-7 pb-1 text-[10px] text-[var(--text-muted)] truncate" title={group.fullPath}>
                {group.fullPath}
              </div>
            )}

            {expanded && group.sessions.map((session) => {
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
                  statusConfigs={statusConfigs}
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

      {projectGroups.length === 0 && (
        <div className="text-center text-[var(--text-muted)] py-8 text-sm">
          {sidebarSearchQuery ? 'No matching sessions' : 'No sessions yet'}
        </div>
      )}
    </div>
  );
}

// SessionItem 组件
function SessionItem({
  session,
  isActive,
  runtimeBadge,
  statusConfigs,
  depth,
  onClick,
  onDelete,
  onCopyResume,
  onTogglePin,
}: {
  session: SessionView;
  isActive: boolean;
  runtimeBadge: 'running' | 'completed' | 'error' | null;
  statusConfigs: StatusConfig[];
  depth: number;
  onClick: () => void;
  onDelete: () => void;
  onCopyResume: () => void;
  onTogglePin: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const currentTodoState = session.todoState || 'todo';
  const currentStatusConfig = statusConfigs.find(s => s.id === currentTodoState);
  const isHighlighted = isActive || menuOpen;

  return (
    <div
      className={`group relative cursor-pointer rounded-xl border px-3 py-1.5 transition-colors duration-150 ${
        isActive
          ? 'border-[var(--border)] shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : menuOpen
            ? 'border-[var(--border)]/70'
            : 'border-transparent bg-transparent hover:border-[var(--border)]/70 hover:bg-[#EEEEEE]'
      }`}
      style={{
        marginLeft: `${depth * 16}px`,
        marginBottom: '4px',
        backgroundColor: isHighlighted ? '#EEEEEE' : undefined,
      }}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 pr-8 min-h-[20px]">
        {currentStatusConfig && (
          <StatusIcon status={currentStatusConfig} className="flex-shrink-0" />
        )}
        {session.pinned && (
          <span className="flex-shrink-0 text-[var(--text-muted)]">
            <Pin className="w-3.5 h-3.5" />
          </span>
        )}
        <span className="flex-1 truncate text-[13px] font-medium leading-[1.25]">{session.title}</span>
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

      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className={`absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition-all duration-150 hover:bg-[var(--bg-tertiary)] ${
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[160px] shadow-lg z-50"
            sideOffset={5}
          >
            <DropdownMenu.Item
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150"
              onClick={onTogglePin}
            >
              <Pin className="w-3.5 h-3.5" />
              {session.pinned ? 'Unpin' : 'Pin to Top'}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
            <StatusMenu sessionId={session.id} currentStatus={currentTodoState} />
            {session.claudeSessionId && (
              <DropdownMenu.Item
                className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150"
                onClick={onCopyResume}
              >
                <Copy className="w-3.5 h-3.5" />
                Copy Resume Command
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 text-red-400"
              onClick={onDelete}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
