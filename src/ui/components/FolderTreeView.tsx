import { toast } from 'sonner';
import { useSessionOrganization, useSessionOrganizationStore, changeSessionOrganization } from '../store/useSessionOrganizationStore';
import { textInputDialog } from './ui/text-input-dialog';
import { useSessionActionsMenu } from '../hooks/useSessionActionsMenu';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Pin,
  SquarePen,
  Trash2,
} from './icons';
import { confirmDialog } from './ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { allLeaves } from '../store/layout-tree';
import { sendEvent } from '../hooks/useIPC';
import { DEFAULT_WORKSPACE_CHANNEL_ID, type GitPullRequestSummary } from '../../shared/types';
import { useSidebarViewOptions, useSidebarViewStore } from '../store/useSidebarViewStore';
import { useSidebarPullRequests } from '../store/useSidebarPullRequests';
import {
  deriveSidebarSessionState,
  isWithinActivityWindow,
  sessionSortTime,
  SIDEBAR_STATE_LABELS,
  SIDEBAR_STATE_ORDER,
  type SidebarSessionState,
} from '../utils/sidebar-view';
import type { AgentProvider, SessionView } from '../types';
import { AgentIcon } from './ComposerAgentControls';
import { SessionHandoffProviderRoute } from './SessionHandoffIndicator';

type ProjectGroup = {
  key: string;
  label: string;
  fullPath: string | null;
  sessions: SessionView[];
};

const DEFAULT_VISIBLE_SESSIONS_PER_PROJECT = 5;
const SESSION_BRANCH_CACHE_TTL_MS = 30_000;

type SessionBranchCacheEntry = {
  branch: string | null;
  expiresAt: number;
};

const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();
const pendingSessionBranchRequests = new Map<string, Promise<string | null>>();

/**
 * Session title that stays truncated until hovered, then scrolls left/right
 * (marquee) so long titles can be read in full. Overflow is measured at
 * runtime; short titles render exactly as before with no animation.
 */
function ScrollingTitle({ title, className = '' }: { title: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [marqueeStyle, setMarqueeStyle] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    const measure = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const distance = inner.scrollWidth - outer.clientWidth;
      const next = distance > 2;
      setOverflowing(next);
      setMarqueeStyle(
        next
          ? ({
              '--marquee-distance': `${-(distance + 6)}px`,
              '--marquee-duration': `${Math.max(2.5, distance / 35)}s`,
            } as CSSProperties)
          : undefined
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (outerRef.current) observer.observe(outerRef.current);
    // Content width changes without the outer resizing (font swap-in, late
    // glyph layout) — watch the inner too so overflow detection never goes
    // stale.
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [title]);

  return (
    <span
      ref={outerRef}
      className={`marquee-title-outer ${className}`}
      data-overflowing={overflowing ? 'true' : undefined}
      style={marqueeStyle}
    >
      <span ref={innerRef} className="marquee-title-inner">
        {title}
      </span>
    </span>
  );
}

const WORKTREE_ACTION_LABELS = {
  move: 'Moving into a new worktree…',
  apply: 'Squash-merging changes back…',
  discard: 'Removing worktree…',
} as const;

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

function getSessionProjectPath(session: SessionView): string | null {
  return session.projectCwd?.trim() || session.cwd?.trim() || null;
}

function getSessionBranchCwd(session: SessionView): string | null {
  return session.worktreePath?.trim() || session.cwd?.trim() || session.projectCwd?.trim() || null;
}

async function readSessionBranch(cwd: string): Promise<string | null> {
  const cached = sessionBranchCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  const pending = pendingSessionBranchRequests.get(cwd);
  if (pending) return pending;

  const request = window.electron
    .getGitBranch(cwd)
    .then((result) => (result.ok ? result.branch?.trim() || null : null))
    .catch(() => null)
    .then((branch) => {
      sessionBranchCache.set(cwd, {
        branch,
        expiresAt: Date.now() + SESSION_BRANCH_CACHE_TTL_MS,
      });
      return branch;
    })
    .finally(() => {
      pendingSessionBranchRequests.delete(cwd);
    });

  pendingSessionBranchRequests.set(cwd, request);
  return request;
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

function ProviderGlyph({ provider }: { provider?: AgentProvider }) {
  return <AgentIcon provider={provider ?? 'claude'} />;
}

// Group by Date 的分组标签（对齐 Codex）：Today / Yesterday / 一周内用星期几，
// 更早的按月份（跨年再带年份），保证每个会话都有归属。
const TIME_GROUP_WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const TIME_GROUP_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long' });
const TIME_GROUP_MONTH_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

function getTimeGroupLabel(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return TIME_GROUP_WEEKDAY_FORMAT.format(date);
  return date.getFullYear() === now.getFullYear()
    ? TIME_GROUP_MONTH_FORMAT.format(date)
    : TIME_GROUP_MONTH_YEAR_FORMAT.format(date);
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
    activeSessionId,
    workspaceLayout,
    sidebarSearchQuery,
    setProjectCwd,
  } = useAppStore();
  const organization = useSessionOrganization();
  const view = useSidebarViewOptions();
  const setViewOption = useSidebarViewStore((state) => state.setOption);
  const prsBySession = useSidebarPullRequests(view.showPullRequests || view.groupBy === 'state');
  // Completed starts folded: Group by State is for what still needs you.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(['state:completed']));
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(
    () => new Set()
  );
  const isChatWorkspaceActive = activeWorkspace === 'chat';

  const activeDraft = activeSessionId ? sessions[activeSessionId] : undefined;
  const activeDraftProject = activeDraft?.isDraft
    ? activeDraft.projectCwd || activeDraft.cwd || '__no_project__'
    : null;
  useLayoutEffect(() => {
    if (!activeDraftProject || !isChatWorkspaceActive) return;
    setCollapsedGroups((current) => {
      if (!current.has(activeDraftProject)) return current;
      const next = new Set(current);
      next.delete(activeDraftProject);
      return next;
    });
  }, [activeSessionId, activeDraftProject, isChatWorkspaceActive]);

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

  const {
    pinnedSessions,
    projectGroups,
    flatSessions,
    stateGroups,
    timeGroups,
    sectionGroups,
    hasHiddenSessions,
    archivedCount,
  } = useMemo(() => {
    const now = Date.now();
    const searching = Boolean(sidebarSearchQuery.trim());
    const byTime = (left: SessionView, right: SessionView) =>
      sessionSortTime(right, view.sortBy) - sessionSortTime(left, view.sortBy);
    const allSessions = Object.values(sessions).filter(
      (session) => !session.hiddenFromThreads && session.scope !== 'dm'
    );
    let sessionList = allSessions;
    if (searching) {
      const query = sidebarSearchQuery.toLowerCase();
      sessionList = sessionList.filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
      );
    }
    // 搜索时不看 Status：归档的会话也要能被搜到
    const status = searching ? 'all' : view.status;
    sessionList = sessionList.filter((session) => {
      const archived = Boolean(organization.sessions[session.id]?.archived);
      if (status === 'active' && archived) return false;
      if (status === 'archived' && !archived) return false;
      if (view.project && getSessionProjectPath(session) !== view.project) return false;
      return session.isDraft || isWithinActivityWindow(session, view.activity, now);
    });
    const hasHiddenSessions = !searching && sessionList.length < allSessions.length;
    const archivedCount = allSessions.filter((session) => organization.sessions[session.id]?.archived).length;

    // Pinned 和自定义 section 只属于按项目/不分组的视图；State/Date 是分诊视图，
    // 每个会话都按自身状态或时间归位
    const usesSections = view.groupBy === 'project' || view.groupBy === 'none';
    const sectionGroups = usesSections
      ? organization.sections.map((section) => ({
          ...section,
          sessions: sessionList
            .filter((session) => organization.sessions[session.id]?.sectionId === section.id)
            .sort(byTime),
        }))
      : [];
    const unsectioned = usesSections
      ? sessionList.filter((session) => !organization.sessions[session.id]?.sectionId)
      : sessionList;
    const pinnedSessions = usesSections
      ? unsectioned.filter((session) => session.pinned).sort(byTime)
      : [];
    const regularSessions = usesSections
      ? unsectioned.filter((session) => !session.pinned)
      : unsectioned;

    const projectGroups: ProjectGroup[] = [];
    if (view.groupBy === 'project') {
      const grouped = new Map<string, ProjectGroup>();
      for (const session of regularSessions) {
        // 按项目根分组：worktree thread 的 cwd 指向 .worktrees/ 下的检出目录，
        // 用 projectCwd 兜底才不会把它当成一个独立"项目"
        const fullPath = getSessionProjectPath(session);
        const key = fullPath || '__no_project__';
        if (!grouped.has(key)) {
          grouped.set(key, { key, label: getProjectLabel(fullPath), fullPath, sessions: [] });
        }
        grouped.get(key)!.sessions.push(session);
      }
      const selectedProjectPath = projectCwd?.trim() || null;
      if (
        selectedProjectPath &&
        !searching &&
        status !== 'archived' &&
        (!view.project || view.project === selectedProjectPath) &&
        !grouped.has(selectedProjectPath)
      ) {
        grouped.set(selectedProjectPath, {
          key: selectedProjectPath,
          label: getProjectLabel(selectedProjectPath),
          fullPath: selectedProjectPath,
          sessions: [],
        });
      }
      const latest = (group: ProjectGroup) =>
        group.sessions[0] ? sessionSortTime(group.sessions[0], view.sortBy) : 0;
      projectGroups.push(
        ...Array.from(grouped.values())
          .map((group) => ({ ...group, sessions: group.sessions.sort(byTime) }))
          .sort((left, right) => latest(right) - latest(left))
      );
    }

    const flatSessions = view.groupBy === 'none' ? [...regularSessions].sort(byTime) : [];

    const stateGroups: { state: SidebarSessionState; sessions: SessionView[] }[] = [];
    if (view.groupBy === 'state') {
      const byState = new Map<SidebarSessionState, SessionView[]>();
      for (const session of regularSessions) {
        const state = deriveSidebarSessionState(session, {
          unread: organization.sessions[session.id]?.unread,
          pullRequest: prsBySession[session.id],
        });
        byState.set(state, [...(byState.get(state) ?? []), session]);
      }
      for (const state of SIDEBAR_STATE_ORDER) {
        const members = byState.get(state);
        if (members?.length) stateGroups.push({ state, sessions: members.sort(byTime) });
      }
    }

    const timeGroups: { label: string; sessions: SessionView[] }[] = [];
    if (view.groupBy === 'date') {
      const nowDate = new Date(now);
      const byLabel = new Map<string, SessionView[]>();
      for (const session of [...regularSessions].sort(byTime)) {
        const label = getTimeGroupLabel(sessionSortTime(session, view.sortBy), nowDate);
        const bucket = byLabel.get(label);
        if (bucket) {
          bucket.push(session);
        } else {
          const sessionsInGroup: SessionView[] = [session];
          byLabel.set(label, sessionsInGroup);
          timeGroups.push({ label, sessions: sessionsInGroup });
        }
      }
    }

    return {
      pinnedSessions,
      projectGroups,
      flatSessions,
      stateGroups,
      timeGroups,
      sectionGroups,
      hasHiddenSessions,
      archivedCount,
    };
  }, [
    projectCwd,
    sessions,
    sidebarSearchQuery,
    organization,
    prsBySession,
    view.status,
    view.project,
    view.activity,
    view.groupBy,
    view.sortBy,
  ]);
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
  const removeProjectGroup = async (group: ProjectGroup) => {
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
      const confirmed = await confirmDialog({
        title: `Remove ${group.label}?`,
        description: details.join(' '),
        confirmLabel: 'Remove project',
      });
      if (!confirmed) {
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

  const runtimeBadgeFor = (session: SessionView, isSessionActive: boolean) =>
    session.runtimeNotice
      ? session.runtimeNotice
      : !isSessionActive && session.status === 'running'
        ? 'running'
        : null;
  // 平铺列表只放会话本身；所属项目在悬停卡片里
  const renderFlatSession = (session: SessionView, keyPrefix: string) => {
    const isSessionActive = isChatWorkspaceActive && openSessionIds.has(session.id);
    return (
      <SessionItem
        key={`${keyPrefix}:${session.id}`}
        session={session}
        isActive={isSessionActive}
        runtimeBadge={runtimeBadgeFor(session, isSessionActive)}
        depth={0}
        pullRequest={view.showPullRequests ? prsBySession[session.id] : null}
        onClick={() => onSessionClick(session.id)}
        onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
      />
    );
  };
  const groupHeaderClass = 'mb-1 flex w-full items-center gap-1.5 px-2 text-left text-[13px] font-normal text-[var(--text-muted)]';
  const editSection = async (id: string, name: string, remove = false) => {
    try {
      if (remove) {
        if (await confirmDialog({ title: `Remove ${name}?`, description: 'Conversations return to their project groups.', confirmLabel: 'Remove section' })) {
          await changeSessionOrganization({ kind: 'remove-section', sectionId: id });
        }
      } else {
        const next = await textInputDialog({ title: 'Rename section', label: 'Section name', value: name, maxLength: 80 });
        if (next) await changeSessionOrganization({ kind: 'rename-section', sectionId: id, name: next });
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };

  return (
    <div>
      {pinnedSessions.length > 0 && (
        <section className="mb-4">
          <div className={groupHeaderClass}>Pinned</div>
          {pinnedSessions.map((session) => renderFlatSession(session, 'pinned'))}
        </section>
      )}
      {sectionGroups.filter(group => !sidebarSearchQuery || group.sessions.length > 0).map(group => (
        <section key={group.id} className="mb-4">
          <div className="group/section mb-1 flex items-center px-2 text-[13px] text-[var(--text-muted)]">
            <button className="min-w-0 flex-1 truncate text-left" aria-expanded={isExpanded(group.id)} onClick={() => toggleGroupExpanded(group.id)}>{group.name}</button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<button aria-label={`Manage ${group.name}`} className="flex h-6 w-6 items-center justify-center opacity-0 group-hover/section:opacity-100 focus:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void editSection(group.id, group.name)}>Rename…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void editSection(group.id, group.name, true)}>Remove section…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {isExpanded(group.id) && (group.sessions.length ? group.sessions.map((session) => renderFlatSession(session, 'section')) : <div className="px-2 py-1 text-[12px] text-[var(--text-muted)]">No threads yet</div>)}
        </section>
      ))}
      {stateGroups.map((group) => {
        const key = `state:${group.state}`;
        const expanded = isExpanded(key);
        return (
          <section key={key} className="mb-4" data-sidebar-state={group.state}>
            <button type="button" className={groupHeaderClass} aria-expanded={expanded} onClick={() => toggleGroupExpanded(key)}>
              <span>{SIDEBAR_STATE_LABELS[group.state]}</span>
              <span className="text-[11.5px] tabular-nums">{group.sessions.length}</span>
              {!expanded ? <ChevronRight className="ml-auto h-3.5 w-3.5" /> : null}
            </button>
            {expanded && group.sessions.map((session) => renderFlatSession(session, 'state'))}
          </section>
        );
      })}
      {timeGroups.map((group) => (
        <section key={group.label} className="mb-4">
          <div className={groupHeaderClass}>{group.label}</div>
          {group.sessions.map((session) => renderFlatSession(session, 'time'))}
        </section>
      ))}
      {flatSessions.length > 0 && (
        <section className="mb-4">
          {flatSessions.map((session) => renderFlatSession(session, 'flat'))}
        </section>
      )}
      {view.groupBy === 'project' && (
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="rounded-md px-1 text-[13px] text-[var(--text-muted)] transition-colors">
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
      )}
      {projectGroups.map((group) => {
        const expanded = isExpanded(group.key);
        const sessionListExpanded = expandedSessionGroups.has(group.key);
        const hasMoreSessions =
          group.sessions.length > DEFAULT_VISIBLE_SESSIONS_PER_PROJECT;
        return (
          <div key={group.key} className="mb-3">
            {/* 整行一个 hover 高亮：标题/加号/更多按钮共用行背景，图标只做颜色反馈 */}
            <div className="group/project mx-1 flex items-center gap-1 rounded-lg pr-1 transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] has-[button[data-popup-open]]:bg-[var(--sidebar-item-hover)]">
              <button
                type="button"
                className="flex min-w-0 flex-1 select-none items-center gap-2 px-2 py-1.5 text-left text-[var(--text-secondary)] transition-colors duration-150 group-hover/project:text-[var(--text-primary)]"
                onClick={() => toggleGroupExpanded(group.key)}
                title={group.fullPath || 'Sessions without a project folder'}
                aria-expanded={expanded}
              >
                {expanded ? <FolderOpen className="w-3.5 h-3.5" /> : <FolderClosed className="w-3.5 h-3.5" />}
                <span className="text-[13px] font-normal truncate flex-1">{group.label}</span>
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-[var(--text-muted)] opacity-0 transition-all duration-150 hover:text-[var(--text-primary)] focus:opacity-100 group-hover/project:opacity-100 data-[popup-open]:text-[var(--text-primary)] data-[popup-open]:opacity-100"
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
                    onSelect={() => void removeProjectGroup(group)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Remove</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {group.fullPath && (
                <button
                  type="button"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-[var(--text-muted)] opacity-0 transition-all duration-150 hover:text-[var(--text-primary)] group-hover/project:opacity-100"
                  title={`New thread in ${group.label}`}
                  aria-label={`New thread in ${group.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSessionForProject(group.fullPath!, DEFAULT_WORKSPACE_CHANNEL_ID);
                  }}
                >
                  <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
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
                          runtimeBadge={runtimeBadgeFor(session, isSessionActive)}
                          depth={depth}
                          pullRequest={view.showPullRequests ? prsBySession[session.id] : null}
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
                                className="group/worktree ml-4 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]"
                                title={`${branch} · ${worktreePath}`}
                              >
                                <GitBranch className="h-3 w-3 flex-shrink-0" />
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                  {branch}
                                </span>
                                <button
                                  type="button"
                                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center opacity-0 transition-all duration-150 hover:text-[var(--text-primary)] focus:opacity-100 group-hover/worktree:opacity-100"
                                  title={`New thread in ${branch}`}
                                  aria-label={`New thread in worktree ${branch}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    createDraftSessionInWorktree(worktreePath, branch, sample);
                                  }}
                                >
                                  <SquarePen className="h-3 w-3" strokeWidth={1.9} />
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

      {sectionGroups.every(group => group.sessions.length === 0) &&
        projectGroups.length === 0 &&
        pinnedSessions.length === 0 &&
        flatSessions.length === 0 &&
        stateGroups.length === 0 &&
        timeGroups.length === 0 && (
          <div className="py-8 text-center text-[13px] text-[var(--text-muted)]">
            {sidebarSearchQuery
              ? 'No matching threads'
              : hasHiddenSessions
                ? 'No threads match these view options'
                : 'No threads yet'}
          </div>
        )}

      {/* 归档入口留在列表底部：点一下就是 Status → Archived，不必先找到视图菜单 */}
      {!sidebarSearchQuery.trim() && (view.status === 'archived' || (view.status === 'active' && archivedCount > 0)) ? (
        <button
          type="button"
          className="mt-2 px-2 text-[13px] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-primary)]"
          onClick={() => setViewOption('status', view.status === 'archived' ? 'active' : 'archived')}
        >
          {view.status === 'archived' ? 'Back to active threads' : 'Archived'}
        </button>
      ) : null}
    </div>
  );
}

const PULL_REQUEST_GLYPH: Record<GitPullRequestSummary['state'], { label: string; className: string }> = {
  open: { label: 'Open', className: 'text-[var(--success)]' },
  merged: { label: 'Merged', className: 'text-[#8b5cf6]' },
  closed: { label: 'Closed', className: 'text-[var(--text-muted)]' },
};

function SessionPullRequestGlyph({ pullRequest }: { pullRequest: GitPullRequestSummary }) {
  const meta = PULL_REQUEST_GLYPH[pullRequest.state];
  const label = `Pull request #${pullRequest.number} · ${meta.label}`;
  const Icon = pullRequest.state === 'merged' ? GitMerge : GitPullRequest;
  return (
    <span className={`flex-shrink-0 ${meta.className}`} title={label}>
      <Icon className="h-3.5 w-3.5" aria-label={label} />
    </span>
  );
}

function SessionItem({
  session,
  isActive,
  runtimeBadge,
  depth,
  pullRequest,
  onClick,
  onTogglePin,
}: {
  session: SessionView;
  isActive: boolean;
  runtimeBadge: 'running' | 'completed' | 'error' | null;
  depth: number;
  pullRequest?: GitPullRequestSummary | null;
  onClick: () => void;
  onTogglePin: () => void;
}) {
  const unread = useSessionOrganizationStore(s => s.sessions[session.id]?.unread);
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!isActive || !session.isDraft) return;
    const frame = window.requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isActive, session.id, session.isDraft]);
  const { openMenu, menuOpen, worktreeAction } = useSessionActionsMenu(session);
  const [branchLookup, setBranchLookup] = useState<{
    cwd: string;
    branch: string | null;
    loading: boolean;
    expiresAt: number;
  } | null>(null);
  const inWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  const projectPath = getSessionProjectPath(session);
  const projectLabel = getProjectLabel(projectPath);
  const branchCwd = getSessionBranchCwd(session);
  const storedWorktreeBranch = session.associatedWorktreeBranch?.trim() || null;
  const lookedUpBranch = branchLookup?.cwd === branchCwd ? branchLookup.branch : null;
  const branch = storedWorktreeBranch || lookedUpBranch;
  const branchLoading = Boolean(
    !storedWorktreeBranch &&
      branchCwd &&
      branchLookup?.cwd === branchCwd &&
      branchLookup.loading
  );
  const handlePreviewOpenChange = (open: boolean) => {
    if (!open || storedWorktreeBranch || !branchCwd) return;
    if (
      branchLookup?.cwd === branchCwd &&
      (branchLookup.loading || branchLookup.expiresAt > Date.now())
    ) {
      return;
    }

    const cached = sessionBranchCache.get(branchCwd);
    if (cached && cached.expiresAt > Date.now()) {
      setBranchLookup({
        cwd: branchCwd,
        branch: cached.branch,
        loading: false,
        expiresAt: cached.expiresAt,
      });
      return;
    }

    setBranchLookup({ cwd: branchCwd, branch: null, loading: true, expiresAt: 0 });
    void readSessionBranch(branchCwd).then((nextBranch) => {
      setBranchLookup({
        cwd: branchCwd,
        branch: nextBranch,
        loading: false,
        expiresAt: sessionBranchCache.get(branchCwd)?.expiresAt ?? Date.now(),
      });
    });
  };

  return (
    <TooltipPrimitive.Root
      disableHoverablePopup
      disabled={menuOpen}
      onOpenChange={handlePreviewOpenChange}
    >
      <TooltipPrimitive.Trigger
        delay={420}
        closeDelay={80}
        render={
          <div
            ref={rowRef}
            data-session-id={session.id}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void openMenu({ x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                void openMenu({ x: rect.left + 12, y: rect.bottom });
              }
            }}
            tabIndex={0}
            aria-current={isActive ? 'page' : undefined}
            className={`group/session relative cursor-pointer rounded-lg py-1 pl-8 pr-3 transition-colors duration-150 ${
              isActive
                ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
            }`}
            style={{
              // -14 lines the provider glyph (16px depth + 32px pin gutter)
              // up with the project label's first letter at 34px.
              marginLeft: `${depth * 16 - 14}px`,
              marginBottom: '1px',
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
              {session.handoffSourceProvider ? (
                <SessionHandoffProviderRoute
                  sourceProvider={session.handoffSourceProvider}
                  targetProvider={session.provider ?? 'claude'}
                />
              ) : (
                <ProviderGlyph provider={session.provider} />
              )}
              <ScrollingTitle title={session.title} className="flex-1 text-[13px] font-normal leading-[1.3]" />
              {unread && <span aria-label="Unread conversation" title="Unread conversation" className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />}
              {worktreeAction ? (
                <span className="flex-shrink-0" title={WORKTREE_ACTION_LABELS[worktreeAction]}>
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]"
                    aria-label={WORKTREE_ACTION_LABELS[worktreeAction]}
                  />
                </span>
              ) : null}
              {pullRequest ? (
                <SessionPullRequestGlyph pullRequest={pullRequest} />
              ) : session.envMode === 'worktree' && session.worktreePath ? (
                <span
                  className="flex-shrink-0"
                  title={`Runs on an isolated branch${session.associatedWorktreeBranch ? ` · ${session.associatedWorktreeBranch}` : ''}`}
                >
                  <GitBranch className="h-3.5 w-3.5 text-[var(--accent)]" aria-label="Runs on an isolated branch" />
                </span>
              ) : null}
              {session.permissionRequests.length > 0 ? (
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full bg-[var(--warning)]"
                  title="Waiting for your approval"
                  aria-label="Waiting for your approval"
                />
              ) : runtimeBadge === 'running' ? (
                <Loader2
                  className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--text-muted)]"
                  title="Session is running"
                  aria-label="Session is running"
                />
              ) : runtimeBadge ? (
                <span
                  className={`status-dot ${runtimeBadge} flex-shrink-0`}
                  title={
                    runtimeBadge === 'completed'
                        ? 'Session completed'
                        : 'Session failed'
                  }
                  aria-label={
                    runtimeBadge === 'completed'
                        ? 'Session completed'
                        : 'Session failed'
                  }
                />
              ) : null}
            </div>
          </div>
        }
      />

      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-[90]"
        >
          <TooltipPrimitive.Popup className="w-[224px] rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] px-3 py-2.5 text-left text-[12px] text-[var(--text-secondary)] shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:translate-x-1 data-[starting-style]:opacity-0 data-[ending-style]:translate-x-1 data-[ending-style]:opacity-0">
            <div className="flex min-w-0 items-baseline gap-3">
              <div className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-[var(--text-primary)]">
                {session.title}
              </div>
              <div className="flex-shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
                {formatSidebarTime(session.updatedAt)}
              </div>
            </div>

            <div className="mt-2 space-y-1.5">
              <div className="flex min-w-0 items-center gap-2" title={projectPath || undefined}>
                <FolderClosed className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate">{projectLabel}</span>
              </div>
              {branch || branchLoading ? (
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch
                    className={`h-3.5 w-3.5 flex-shrink-0 ${inWorktree ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                  />
                  <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${branchLoading ? 'text-[var(--text-muted)]' : ''}`}>
                    {branchLoading ? 'Checking branch…' : branch}
                  </span>
                </div>
              ) : null}
              {inWorktree ? (
                <div className="pl-[22px] text-[11px] leading-4 text-[var(--text-muted)]">
                  Runs on an isolated branch — changes stay here until you apply them back to the
                  project.
                </div>
              ) : null}
            </div>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
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
        <ScrollingTitle title={primary.title} className="min-w-0 flex-1 font-normal" />
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
        <ScrollingTitle title={secondary.title} className="min-w-0 flex-1 font-normal" />
      </button>
    </div>
  );
}
