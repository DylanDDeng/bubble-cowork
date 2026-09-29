import type { GitPullRequestSummary } from '../../shared/types';
import type { SessionView } from '../types';

export type SidebarStatusFilter = 'active' | 'archived' | 'all';
export type SidebarActivityWindow = '1d' | '7d' | '30d' | 'all';
export type SidebarGroupBy = 'project' | 'state' | 'date' | 'none';
export type SidebarSortBy = 'updated' | 'created';

export interface SidebarViewOptions {
  status: SidebarStatusFilter;
  /** Project root to show alone, or null for every project. */
  project: string | null;
  activity: SidebarActivityWindow;
  groupBy: SidebarGroupBy;
  sortBy: SidebarSortBy;
  showPullRequests: boolean;
}

export const DEFAULT_SIDEBAR_VIEW: SidebarViewOptions = {
  status: 'active',
  project: null,
  activity: 'all',
  groupBy: 'project',
  sortBy: 'updated',
  showPullRequests: true,
};

export const SIDEBAR_STATUS_LABELS: Record<SidebarStatusFilter, string> = {
  active: 'Active',
  archived: 'Archived',
  all: 'All',
};

export const SIDEBAR_ACTIVITY_LABELS: Record<SidebarActivityWindow, string> = {
  '1d': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

export const SIDEBAR_GROUP_LABELS: Record<SidebarGroupBy, string> = {
  project: 'Project',
  state: 'State',
  date: 'Date',
  none: 'None',
};

export const SIDEBAR_SORT_LABELS: Record<SidebarSortBy, string> = {
  updated: 'Last activity',
  created: 'Created',
};

const ACTIVITY_WINDOW_MS: Record<Exclude<SidebarActivityWindow, 'all'>, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function isDefaultSidebarView(options: SidebarViewOptions): boolean {
  return (Object.keys(DEFAULT_SIDEBAR_VIEW) as (keyof SidebarViewOptions)[]).every(
    (key) => options[key] === DEFAULT_SIDEBAR_VIEW[key]
  );
}

export function isWithinActivityWindow(
  session: Pick<SessionView, 'updatedAt'>,
  activity: SidebarActivityWindow,
  now: number
): boolean {
  if (activity === 'all') return true;
  return now - session.updatedAt <= ACTIVITY_WINDOW_MS[activity];
}

export function sessionSortTime(session: Pick<SessionView, 'updatedAt' | 'createdAt'>, sortBy: SidebarSortBy): number {
  return sortBy === 'created' ? session.createdAt ?? session.updatedAt : session.updatedAt;
}

/**
 * Where a session stands, most urgent first. Derived on every render and
 * never stored: reading a result or merging its PR is what moves it on.
 */
export type SidebarSessionState = 'needs-input' | 'running' | 'review' | 'completed';

export const SIDEBAR_STATE_ORDER: SidebarSessionState[] = ['needs-input', 'running', 'review', 'completed'];

export const SIDEBAR_STATE_LABELS: Record<SidebarSessionState, string> = {
  'needs-input': 'Needs input',
  running: 'Running',
  review: 'Ready for review',
  completed: 'Completed',
};

export function deriveSidebarSessionState(
  session: Pick<
    SessionView,
    'status' | 'permissionRequests' | 'runtimeNotice' | 'envMode' | 'worktreePath'
  >,
  context: { unread?: boolean; pullRequest?: GitPullRequestSummary | null }
): SidebarSessionState {
  const running = session.status === 'running' || session.status === 'stopping';
  if (session.permissionRequests.length > 0) return 'needs-input';
  if (running) return 'running';
  // Only a failure you have not looked at yet; an old one you already saw
  // would otherwise sit in Needs input forever.
  if (session.runtimeNotice === 'error') return 'needs-input';
  if (session.runtimeNotice === 'completed' || context.unread) return 'review';
  const pr = context.pullRequest;
  if (pr?.state === 'open') return 'review';
  // A live worktree holds work that has not been applied back yet, unless
  // its PR already landed (or was closed) upstream.
  if (session.envMode === 'worktree' && session.worktreePath && !pr) return 'review';
  return 'completed';
}
