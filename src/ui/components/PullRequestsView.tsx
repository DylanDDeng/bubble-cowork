import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { toast } from 'sonner';
import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  X,
} from './icons';
import { SidebarHeaderTrigger } from './Sidebar';
import { MDContent } from '../render/markdown';
import { useAppStore } from '../store/useAppStore';
import type {
  PullRequestCheckItem,
  PullRequestDetail,
  PullRequestListResult,
  PullRequestSummary,
} from '../types';

type RoleTab = 'all' | 'reviewing' | 'authored';

const PR_LIST_WIDTH_KEY = 'aegis-pr-list-width';
const PR_LIST_MIN_WIDTH = 300;
const PR_LIST_MAX_WIDTH = 680;
const PR_LIST_DEFAULT_WIDTH = 420;

function readStoredListWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(PR_LIST_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(PR_LIST_MAX_WIDTH, Math.max(PR_LIST_MIN_WIDTH, stored));
    }
  } catch {
    // storage unavailable
  }
  return PR_LIST_DEFAULT_WIDTH;
}

const ROLE_TABS: Array<{ id: RoleTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'reviewing', label: 'Reviewing' },
  { id: 'authored', label: 'Authored' },
];

function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / (7 * 86_400))}w`;
  return `${Math.floor(seconds / (30 * 86_400))}mo`;
}

function matchesTab(pr: PullRequestSummary, tab: RoleTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'reviewing') return pr.role === 'reviewing' || pr.role === 'both';
  return pr.role === 'authored' || pr.role === 'both';
}

function matchesQuery(pr: PullRequestSummary, query: string): boolean {
  if (!query) return true;
  const blob = `${pr.title} ${pr.repo} ${pr.headRefName || ''} ${pr.author}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => blob.includes(term));
}

/**
 * Bot comments pad decorative logos with `&nbsp;` runs; once the logo is
 * hidden those non-collapsing spaces read as a hole in the sentence. Regular
 * spaces collapse away in HTML rendering.
 */
function normalizePrMarkdown(body: string): string {
  return body.replace(/&nbsp;|\u00a0/g, ' ');
}

function formatTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

const CHECK_ITEM_PRESENTATION: Record<
  PullRequestCheckItem['state'],
  { label: string; tone: string; Icon: typeof CheckCircle2 }
> = {
  passed: { label: 'Passed', tone: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'text-red-600 dark:text-red-400', Icon: CircleX },
  pending: { label: 'Running', tone: 'text-amber-600 dark:text-amber-400', Icon: Loader2 },
  skipped: { label: 'Skipped', tone: 'text-[var(--text-muted)]', Icon: CircleDashed },
  neutral: { label: 'Neutral', tone: 'text-[var(--text-muted)]', Icon: CircleDashed },
};

function CommentAvatar({
  login,
  avatarUrl,
  sizeClassName = 'h-6 w-6',
}: {
  login: string;
  avatarUrl?: string;
  sizeClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl || (login ? `https://github.com/${login}.png?size=48` : '');
  if (failed || !src) {
    return (
      <span
        className={`flex ${sizeClassName} shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[11px] font-semibold text-[var(--text-secondary)]`}
      >
        {(login || '?').slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      onError={() => setFailed(true)}
      alt=""
      className={`${sizeClassName} shrink-0 rounded-full`}
    />
  );
}

function DraftDot({ pr }: { pr: PullRequestSummary }) {
  return (
    <span className="relative mt-0.5 shrink-0 text-[var(--text-muted)]">
      <GitPullRequest className="h-4 w-4" />
      {pr.isDraft ? (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[var(--bg-primary)] bg-red-500" />
      ) : null}
    </span>
  );
}

function ChecksBadge({ detail }: { detail: PullRequestDetail }) {
  const { state, summary } = detail.checks;
  const tone =
    state === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : state === 'failure'
        ? 'text-red-600 dark:text-red-400'
        : 'text-[var(--text-secondary)]';
  return <span className={`text-[13px] ${tone}`}>{summary}</span>;
}

export function PullRequestsView() {
  const { sidebarCollapsed } = useAppStore();
  const [result, setResult] = useState<PullRequestListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<RoleTab>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [checksExpanded, setChecksExpanded] = useState(true);
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [listWidth, setListWidth] = useState<number>(readStoredListWidth);
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;

  const handleResizeStart = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(
        PR_LIST_MAX_WIDTH,
        Math.max(PR_LIST_MIN_WIDTH, startWidth + (moveEvent.clientX - startX))
      );
      setListWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem(PR_LIST_WIDTH_KEY, String(listWidthRef.current));
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const load = useCallback(async (forceReload: boolean) => {
    setLoading(true);
    try {
      const next = await window.electron.listPullRequests(forceReload);
      setResult(next);
      setSelectedId((current) =>
        current && next.prs.some((pr) => pr.id === current) ? current : next.prs[0]?.id || null
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load pull requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const prs = result?.prs || [];
  const filtered = useMemo(
    () => prs.filter((pr) => matchesTab(pr, tab) && matchesQuery(pr, query.trim())),
    [prs, query, tab]
  );
  const selected = useMemo(
    () => prs.find((pr) => pr.id === selectedId) || null,
    [prs, selectedId]
  );

  const loadDetail = useCallback(
    async (forceReload: boolean) => {
      if (!selected) return;
      setDetailLoading(true);
      try {
        setDetail(
          await window.electron.getPullRequestDetail({
            repo: selected.repo,
            number: selected.number,
            forceReload,
          })
        );
      } catch (error) {
        setDetail(null);
        toast.error(error instanceof Error ? error.message : 'Failed to load PR details.');
      } finally {
        setDetailLoading(false);
      }
    },
    [selected]
  );

  useEffect(() => {
    setConfirmMerge(false);
    setCommentDraft('');
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(false);
  }, [loadDetail, selected]);

  const handlePostComment = async () => {
    if (!detail || !commentDraft.trim() || postingComment) return;
    setPostingComment(true);
    try {
      const outcome = await window.electron.addPullRequestComment({
        repo: detail.repo,
        number: detail.number,
        body: commentDraft,
      });
      if (!outcome.ok) {
        toast.error(outcome.message || 'Failed to post the comment.');
        return;
      }
      setCommentDraft('');
      await loadDetail(true);
    } finally {
      setPostingComment(false);
    }
  };

  const handleMerge = async () => {
    if (!detail) return;
    if (!confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setMerging(true);
    try {
      const outcome = await window.electron.mergePullRequest({
        repo: detail.repo,
        number: detail.number,
        method: 'merge',
      });
      if (!outcome.ok) {
        toast.error(outcome.message || 'Merge failed.');
        return;
      }
      toast.success(`Merged ${detail.repo}#${detail.number}`);
      await load(true);
    } finally {
      setMerging(false);
      setConfirmMerge(false);
    }
  };

  const listError = result?.error;

  return (
    <div className="flex-1 min-w-0 flex bg-[var(--bg-primary)]">
        <section className="flex flex-shrink-0 flex-col" style={{ width: listWidth }}>
          <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0`}>
            <div className="flex h-full items-center px-3">
              {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
            </div>
          </div>
          <div className="space-y-3 px-4 pb-3 pt-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1" role="tablist" aria-label="Pull request filters">
                {ROLE_TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === entry.id}
                    onClick={() => setTab(entry.id)}
                    className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                      tab === entry.id
                        ? 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void load(true)}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh pull requests"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pull requests"
                className="h-9 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-8 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {listError ? (
              <div className="mx-2 mt-2 rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[13px] leading-6 text-[var(--text-secondary)]">
                {listError.message}
              </div>
            ) : loading && prs.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-[var(--text-secondary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading pull requests...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-[13px] text-[var(--text-muted)]">
                {prs.length === 0 ? 'No open pull requests.' : 'No pull requests match this filter.'}
              </div>
            ) : (
              filtered.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  onClick={() => setSelectedId(pr.id)}
                  className={`group flex w-full items-start gap-3 rounded-[var(--radius-xl)] px-3 py-3 text-left transition-colors ${
                    selectedId === pr.id ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'
                  }`}
                >
                  <DraftDot pr={pr} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                        {pr.title}
                      </span>
                      <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-muted)]">
                        {formatAge(pr.updatedAt)}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[11.5px] text-[var(--text-muted)]">
                      <span className="min-w-0 truncate">
                        {pr.repo}
                        {pr.headRefName ? `  ${pr.headRefName}` : ''}
                      </span>
                      {typeof pr.additions === 'number' && typeof pr.deletions === 'number' ? (
                        <span className="shrink-0 tabular-nums">
                          <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span>{' '}
                          <span className="text-red-600 dark:text-red-400">-{pr.deletions}</span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Draggable divider: 9px hit strip around a 1px line. */}
        <div
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pull request list"
          className="group relative z-10 -mx-1 w-[9px] shrink-0 cursor-col-resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)] transition-colors group-hover:bg-[var(--text-muted)] group-active:bg-[var(--text-muted)]" />
        </div>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0`} />
          <div className="min-h-0 flex-1 overflow-y-auto">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
              Select a pull request to inspect it.
            </div>
          ) : (
            <div className="mx-auto max-w-[860px] px-8 pb-12 pt-2">
              <div className="flex items-start justify-between gap-4">
                <h1 className="min-w-0 text-[24px] font-semibold leading-snug tracking-[-0.01em] text-[var(--text-primary)]">
                  {selected.title}
                </h1>
                <div className="flex shrink-0 items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void window.electron.openExternalUrl(selected.url)}
                    title="Open on GitHub"
                    aria-label="Open on GitHub"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                  {detail && detail.state === 'OPEN' ? (
                    confirmMerge ? (
                      <span className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleMerge()}
                          disabled={merging}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-[12.5px] font-medium text-[var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {merging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Confirm merge
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmMerge(false)}
                          disabled={merging}
                          className="inline-flex h-8 items-center rounded-md px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleMerge()}
                        disabled={detail.isDraft || detail.mergeable === 'CONFLICTING'}
                        title={
                          detail.isDraft
                            ? 'Draft pull requests cannot be merged.'
                            : detail.mergeable === 'CONFLICTING'
                              ? 'This pull request has conflicts.'
                              : 'Merge this pull request'
                        }
                        className="inline-flex h-8 items-center rounded-md bg-[var(--text-primary)] px-3.5 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Merge
                      </button>
                    )
                  ) : null}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--text-muted)]">
                <CommentAvatar login={selected.author} sizeClassName="h-5 w-5" />
                <span className="font-medium text-[var(--text-secondary)]">{selected.author}</span>
                <span>·</span>
                <span>{formatAge(selected.createdAt)}</span>
                {selected.isDraft ? (
                  <>
                    <span>·</span>
                    <span>Draft</span>
                  </>
                ) : null}
              </div>

              <dl className="mt-6 space-y-3 border-b border-[var(--border)] pb-6 text-[13px]">
                <div className="flex items-center gap-3">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-[var(--text-muted)]">
                    <GitBranch className="h-3.5 w-3.5" />
                    Branch
                  </dt>
                  <dd className="min-w-0 flex flex-wrap items-center gap-2 text-[var(--text-primary)]">
                    <span className="truncate font-mono text-[12px]">{detail?.headRefName || selected.headRefName || '—'}</span>
                    <span className="text-[var(--text-muted)]">→</span>
                    <span className="font-mono text-[12px]">{detail?.baseRefName || selected.baseRefName || '—'}</span>
                    {typeof selected.additions === 'number' && typeof selected.deletions === 'number' ? (
                      <span className="tabular-nums text-[12px]">
                        <span className="text-emerald-600 dark:text-emerald-400">+{selected.additions}</span>{' '}
                        <span className="text-red-600 dark:text-red-400">-{selected.deletions}</span>
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-[var(--text-muted)]">
                    <GitPullRequest className="h-3.5 w-3.5" />
                    Reviewers
                  </dt>
                  <dd className="text-[var(--text-secondary)]">
                    {detail && detail.reviewers.length > 0
                      ? detail.reviewers.map((reviewer) => reviewer.login).join(', ')
                      : 'No reviewers'}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-[var(--text-muted)]">
                    <MessageCircle className="h-3.5 w-3.5" />
                    Comments
                  </dt>
                  <dd className="text-[var(--text-secondary)]">
                    {detail ? `${detail.commentCount} comment${detail.commentCount === 1 ? '' : 's'}` : '—'}
                  </dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="flex w-28 shrink-0 items-center gap-2 text-[var(--text-muted)]">
                    <RefreshCw className="h-3.5 w-3.5" />
                    Checks
                  </dt>
                  <dd>{detail ? <ChecksBadge detail={detail} /> : '—'}</dd>
                </div>
              </dl>

              <div className="pt-6">
                {detailLoading && !detail ? (
                  <div className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading description...
                  </div>
                ) : detail?.body?.trim() ? (
                  <MDContent content={normalizePrMarkdown(detail.body)} allowHtml className="project-markdown-preview pr-markdown" />
                ) : (
                  <p className="text-[13px] text-[var(--text-muted)]">No description provided.</p>
                )}
              </div>

              {detail && detail.checks.items.length > 0 ? (
                <div className="mt-8 border-t border-[var(--border)] pt-5">
                  <button
                    type="button"
                    onClick={() => setChecksExpanded((current) => !current)}
                    className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--text-primary)]"
                    aria-expanded={checksExpanded}
                  >
                    Checks
                    <ChevronDown
                      className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${
                        checksExpanded ? '' : '-rotate-90'
                      }`}
                    />
                  </button>
                  {checksExpanded ? (
                    <div className="mt-3">
                      {detail.checks.items.map((item) => {
                        const presentation = CHECK_ITEM_PRESENTATION[item.state];
                        const StateIcon = presentation.Icon;
                        return (
                          <div
                            key={`${item.workflowName || ''}/${item.name}`}
                            className="flex items-center gap-2.5 py-1.5 text-[13px]"
                          >
                            <StateIcon
                              className={`h-4 w-4 shrink-0 ${presentation.tone} ${
                                item.state === 'pending' ? 'animate-spin' : ''
                              }`}
                            />
                            <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                              {item.name}
                              {item.url ? (
                                <button
                                  type="button"
                                  onClick={() => void window.electron.openExternalUrl(item.url!)}
                                  title="Open check details"
                                  aria-label={`Open ${item.name} details`}
                                  className="ml-2 inline-flex align-middle text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </span>
                            <span className="shrink-0 text-[12.5px] text-[var(--text-muted)]">
                              {presentation.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {detail ? (
                <div className="mt-8 border-t border-[var(--border)] pt-5">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
                    Comments
                    <span className="font-normal text-[var(--text-muted)]">{detail.comments.length}</span>
                  </h2>

                  {detail.comments.length > 0 ? (
                    <div className="mt-4 space-y-4">
                      {detail.comments.map((comment, index) => (
                        <article
                          key={`${comment.author}-${comment.createdAt}-${index}`}
                          className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)]"
                        >
                          <header className="flex flex-wrap items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] px-4 py-2.5 text-[12.5px]">
                            <CommentAvatar login={comment.author} avatarUrl={comment.avatarUrl} />
                            <span className="font-medium text-[var(--text-primary)]">{comment.author}</span>
                            {comment.kind === 'review' && comment.reviewState ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  comment.reviewState === 'APPROVED'
                                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                                    : comment.reviewState === 'CHANGES_REQUESTED'
                                      ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                                }`}
                              >
                                {comment.reviewState.toLowerCase().replace(/_/g, ' ')}
                              </span>
                            ) : null}
                            <span className="ml-auto text-[var(--text-muted)]">
                              {formatTimestamp(comment.createdAt)}
                            </span>
                            {comment.url ? (
                              <button
                                type="button"
                                onClick={() => void window.electron.openExternalUrl(comment.url!)}
                                title="Open comment on GitHub"
                                aria-label="Open comment on GitHub"
                                className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </header>
                          <div className="px-4 py-3">
                            <MDContent
                              content={normalizePrMarkdown(comment.body)}
                              allowHtml
                              className="project-markdown-preview pr-markdown"
                            />
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-[13px] text-[var(--text-muted)]">No comments yet.</p>
                  )}

                  <div className="mt-4 flex items-end gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
                    <textarea
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void handlePostComment();
                        }
                      }}
                      placeholder="Leave a comment"
                      rows={Math.min(6, Math.max(1, commentDraft.split('\n').length))}
                      className="min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    />
                    <button
                      type="button"
                      onClick={() => void handlePostComment()}
                      disabled={!commentDraft.trim() || postingComment}
                      title="Post comment (⌘↩)"
                      aria-label="Post comment"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-30"
                    >
                      {postingComment ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ArrowUp className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
          </div>
        </section>
    </div>
  );
}
