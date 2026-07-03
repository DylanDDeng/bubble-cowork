import { useEffect, useMemo, useState } from 'react';
import type { AgentProvider, RunGroupInfo, RunGroupMember } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { AgentIcon } from './ComposerAgentControls';
import { ChevronDown, ChevronRight, GitFork, SquareTerminal, X } from './icons';

export function isCustomMember(member: RunGroupMember): boolean {
  return member.provider.startsWith('custom:');
}

export function memberLabel(member: RunGroupMember): string {
  if (isCustomMember(member)) return member.runtimeName || 'Custom CLI';
  return member.model ? `${member.provider} · ${member.model}` : member.provider;
}

export function MemberIcon({ member }: { member: RunGroupMember }) {
  if (isCustomMember(member)) {
    return <SquareTerminal className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />;
  }
  return <AgentIcon provider={member.provider as AgentProvider} />;
}

function memberStatusDotClass(status: string | null): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-500 animate-pulse';
    case 'error':
      return 'bg-rose-500';
    case 'idle':
    case 'completed':
      return 'bg-[var(--text-muted)]';
    default:
      return 'bg-amber-500';
  }
}

function groupStatusLabel(group: RunGroupInfo): string {
  switch (group.status) {
    case 'running':
      return 'running';
    case 'settled':
      return 'done — compare';
    case 'adopted':
      return 'adopted';
    case 'discarded':
      return 'discarded';
    case 'cancelled':
      return 'cancelled';
    default:
      return group.status;
  }
}

function MemberRow({
  member,
  active,
  onOpen,
}: {
  member: RunGroupMember;
  active: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const session = useAppStore((state) =>
    member.sessionId ? state.sessions[member.sessionId] : undefined
  );
  const openRunGroupTerminal = useAppStore((state) => state.openRunGroupTerminal);
  const custom = isCustomMember(member);
  const status = custom
    ? member.phase === 'running'
      ? 'running'
      : member.phase === 'failed'
        ? 'error'
        : member.phase === 'done'
          ? 'idle'
          : null
    : member.phase === 'failed' && !session
      ? 'error'
      : (session?.status ?? null);
  const openable = custom ? Boolean(member.terminalThreadId && member.worktreePath) : Boolean(member.sessionId);
  const handleOpen = () => {
    if (custom) {
      if (member.terminalThreadId && member.worktreePath) {
        openRunGroupTerminal({
          threadId: member.terminalThreadId,
          cwd: member.worktreePath,
          title: memberLabel(member),
        });
      }
      return;
    }
    if (member.sessionId) onOpen(member.sessionId);
  };
  return (
    <button
      type="button"
      disabled={!openable}
      onClick={handleOpen}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md pl-7 pr-2 text-left transition-colors duration-150 disabled:cursor-not-allowed ${
        active
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      title={member.failReason || member.branch || memberLabel(member)}
    >
      <MemberIcon member={member} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{memberLabel(member)}</span>
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${memberStatusDotClass(status)}`}
        aria-hidden="true"
      />
    </button>
  );
}

// Sidebar 的 fan-out 分区：group 是可展开条目，成员不散落在普通 thread 列表里。
// 数据自管（listRunGroups + runGroup.changed 订阅），布局绝不在此触发。
export function RunGroupList({
  projectCwd,
  onOpenSession,
}: {
  projectCwd?: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [groups, setGroups] = useState<RunGroupInfo[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setRunGroupViewId = useAppStore((state) => state.setRunGroupViewId);

  useEffect(() => {
    let disposed = false;
    void window.electron.listRunGroups().then((list) => {
      if (!disposed) setGroups(list);
    });
    const unsubscribe = window.electron.onServerEvent((event) => {
      if (event.type !== 'runGroup.changed') return;
      const group = event.payload.group;
      setGroups((prev) => {
        const index = prev.findIndex((item) => item.id === group.id);
        if (index === -1) return [group, ...prev];
        const next = [...prev];
        next[index] = group;
        return next;
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const visibleGroups = useMemo(() => {
    const normalizedCwd = projectCwd?.trim() || null;
    return groups.filter((group) => {
      if (group.status === 'discarded') return false;
      if (normalizedCwd && group.projectCwd !== normalizedCwd) return false;
      return true;
    });
  }, [groups, projectCwd]);

  if (visibleGroups.length === 0) return null;

  const toggle = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <div className="mb-2">
      <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Fan-outs
      </div>
      {visibleGroups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        const runningCount = group.members.filter((m) => m.phase !== 'failed').length;
        return (
          <div key={group.id} className="mb-0.5">
            <div className="group/rg flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(group.id);
                }}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                aria-label={isCollapsed ? 'Expand fan-out' : 'Collapse fan-out'}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-[var(--text-muted)]" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setRunGroupViewId(group.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={`${group.prompt} — open comparison`}
              >
                <GitFork className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{group.prompt}</span>
                <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                  {runningCount} · {groupStatusLabel(group)}
                </span>
              </button>
              {group.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => {
                    void window.electron.cancelRunGroup(group.id);
                  }}
                  className="hidden h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] group-hover/rg:flex"
                  title="Cancel fan-out"
                  aria-label="Cancel fan-out"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            {!isCollapsed
              ? group.members.map((member) => (
                  <MemberRow
                    key={`${group.id}-${member.index}`}
                    member={member}
                    active={Boolean(member.sessionId) && member.sessionId === activeSessionId}
                    onOpen={onOpenSession}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}
