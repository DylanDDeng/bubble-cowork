import { execFile } from 'child_process';
import type {
  PullRequestCheckItem,
  PullRequestCheckState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestListResult,
  PullRequestSummary,
} from '../../shared/types';

/**
 * GitHub pull-request directory backed by the machine's `gh` CLI (reuses its
 * login; no tokens stored). List = two `gh search prs` sweeps (authored +
 * review-requested) enriched per-PR with branch/diffstat via `gh pr view`.
 */

const GH_TIMEOUT_MS = 20_000;
const LIST_CACHE_TTL_MS = 60_000;
const DETAIL_CACHE_TTL_MS = 30_000;
const ENRICH_CONCURRENCY = 4;
const SEARCH_LIMIT = 50;

const SEARCH_FIELDS = 'number,title,repository,author,createdAt,updatedAt,isDraft,url';
const VIEW_LIST_FIELDS = 'headRefName,baseRefName,additions,deletions,state';
const VIEW_DETAIL_FIELDS = [
  'number',
  'title',
  'body',
  'author',
  'baseRefName',
  'headRefName',
  'additions',
  'deletions',
  'isDraft',
  'state',
  'url',
  'createdAt',
  'updatedAt',
  'reviewRequests',
  'latestReviews',
  'comments',
  'statusCheckRollup',
  'mergeable',
].join(',');

let listCache: { fetchedAt: number; result: PullRequestListResult } | null = null;
const detailCache = new Map<string, { fetchedAt: number; detail: PullRequestDetail }>();
const diffCache = new Map<string, { fetchedAt: number; diff: string }>();
const commitsCache = new Map<string, { fetchedAt: number; commits: PullRequestCommit[] }>();

class GhCliError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_installed' | 'auth_required' | 'command_failed'
  ) {
    super(message);
    this.name = 'GhCliError';
  }
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = String(stderr || error.message || '').trim();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new GhCliError(
              'GitHub CLI (gh) was not found. Install it with `brew install gh`.',
              'not_installed'
            )
          );
          return;
        }
        if (/auth login|authentication|HTTP 401|Bad credentials/i.test(detail)) {
          reject(
            new GhCliError(
              'GitHub CLI is not signed in. Run `gh auth login`, then retry.',
              'auth_required'
            )
          );
          return;
        }
        reject(new GhCliError(detail || 'gh command failed.', 'command_failed'));
      }
    );
  });
}

async function runGhJson<T>(args: string[]): Promise<T> {
  const stdout = await runGh(args);
  return JSON.parse(stdout) as T;
}

type RawSearchEntry = {
  number?: number;
  title?: string;
  repository?: { nameWithOwner?: string };
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
  isDraft?: boolean;
  url?: string;
};

function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function toSummary(raw: RawSearchEntry, role: PullRequestSummary['role']): PullRequestSummary | null {
  const repo = raw.repository?.nameWithOwner?.trim();
  const number = raw.number;
  if (!repo || !Number.isFinite(number)) {
    return null;
  }
  return {
    id: prKey(repo, number!),
    repo,
    number: number!,
    title: raw.title?.trim() || `#${number}`,
    author: raw.author?.login || '',
    isDraft: Boolean(raw.isDraft),
    state: 'OPEN',
    createdAt: raw.createdAt || '',
    updatedAt: raw.updatedAt || '',
    url: raw.url || `https://github.com/${repo}/pull/${number}`,
    role,
  };
}

/**
 * Roll the per-check statuses up into one chip state plus per-check items.
 * Rollup entries mix CheckRun ({name, status, conclusion, detailsUrl}) and
 * StatusContext ({context, state, targetUrl}) shapes.
 */
function rollupChecks(
  rollup: Array<Record<string, unknown>> | undefined
): { state: PullRequestCheckState; summary: string; items: PullRequestCheckItem[] } {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) {
    return { state: 'none', summary: 'No checks', items: [] };
  }

  const items: PullRequestCheckItem[] = checks.map((check) => {
    const name = String(check.name || check.context || 'check');
    const workflowName = typeof check.workflowName === 'string' ? check.workflowName : undefined;
    const url =
      typeof check.detailsUrl === 'string'
        ? check.detailsUrl
        : typeof check.targetUrl === 'string'
          ? check.targetUrl
          : undefined;
    const status = String(check.status || '').toUpperCase();
    const conclusion = String(check.conclusion || check.state || '').toUpperCase();
    let state: PullRequestCheckItem['state'];
    if (status && status !== 'COMPLETED') {
      state = 'pending';
    } else if (['SUCCESS', 'EXPECTED'].includes(conclusion)) {
      state = 'passed';
    } else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'].includes(conclusion)) {
      state = 'failed';
    } else if (conclusion === 'SKIPPED') {
      state = 'skipped';
    } else {
      state = 'neutral';
    }
    return { name, workflowName, state, url };
  });

  const failed = items.filter((item) => item.state === 'failed').length;
  const pending = items.filter((item) => item.state === 'pending').length;
  if (failed > 0) {
    return { state: 'failure', summary: `${failed} of ${items.length} checks failing`, items };
  }
  if (pending > 0) {
    return { state: 'pending', summary: `${pending} of ${items.length} checks running`, items };
  }
  return { state: 'success', summary: 'Checks successful', items };
}

async function enrichSummaries(summaries: PullRequestSummary[]): Promise<void> {
  const queue = [...summaries];
  const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const summary = queue.shift();
      if (!summary) return;
      try {
        const view = await runGhJson<Record<string, unknown>>([
          'pr', 'view', String(summary.number),
          '--repo', summary.repo,
          '--json', VIEW_LIST_FIELDS,
        ]);
        summary.headRefName = typeof view.headRefName === 'string' ? view.headRefName : undefined;
        summary.baseRefName = typeof view.baseRefName === 'string' ? view.baseRefName : undefined;
        summary.additions = typeof view.additions === 'number' ? view.additions : undefined;
        summary.deletions = typeof view.deletions === 'number' ? view.deletions : undefined;
        if (typeof view.state === 'string' && view.state) {
          summary.state = view.state as PullRequestSummary['state'];
        }
      } catch {
        // Branch/diffstat are decoration — the row still renders without them.
      }
    }
  });
  await Promise.all(workers);
}

export async function listPullRequests(forceReload = false): Promise<PullRequestListResult> {
  if (!forceReload && listCache && Date.now() - listCache.fetchedAt < LIST_CACHE_TTL_MS) {
    return { ...listCache.result, cached: true };
  }

  try {
    const searchArgs = (extra: string[]) => [
      'search', 'prs', ...extra,
      '--state', 'open',
      '--limit', String(SEARCH_LIMIT),
      '--json', SEARCH_FIELDS,
    ];
    const [authoredRaw, reviewingRaw] = await Promise.all([
      runGhJson<RawSearchEntry[]>(searchArgs(['--author', '@me'])),
      runGhJson<RawSearchEntry[]>(searchArgs(['--review-requested', '@me'])),
    ]);

    const byId = new Map<string, PullRequestSummary>();
    for (const raw of authoredRaw) {
      const summary = toSummary(raw, 'authored');
      if (summary) byId.set(summary.id, summary);
    }
    for (const raw of reviewingRaw) {
      const summary = toSummary(raw, 'reviewing');
      if (!summary) continue;
      const existing = byId.get(summary.id);
      if (existing) {
        existing.role = 'both';
      } else {
        byId.set(summary.id, summary);
      }
    }

    const prs = [...byId.values()].sort((left, right) =>
      (right.updatedAt || '').localeCompare(left.updatedAt || '')
    );
    await enrichSummaries(prs);

    const result: PullRequestListResult = { prs, fetchedAt: Date.now(), cached: false };
    listCache = { fetchedAt: Date.now(), result };
    return result;
  } catch (error) {
    const kind = error instanceof GhCliError ? error.kind : 'command_failed';
    const message = error instanceof Error ? error.message : String(error);
    // Serve stale data over an error flash when a refresh fails.
    if (listCache) {
      return { ...listCache.result, cached: true, error: { kind, message } };
    }
    return { prs: [], fetchedAt: Date.now(), cached: false, error: { kind, message } };
  }
}

export async function getPullRequestDetail(
  repo: string,
  number: number,
  forceReload = false
): Promise<PullRequestDetail> {
  const key = prKey(repo, number);
  const cached = detailCache.get(key);
  if (!forceReload && cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
    return cached.detail;
  }

  // The REST comments endpoint carries user.avatar_url, which `gh pr view
  // --json comments` omits (bots have no github.com/<login>.png fallback).
  const [view, apiComments] = await Promise.all([
    runGhJson<Record<string, unknown>>([
      'pr', 'view', String(number),
      '--repo', repo,
      '--json', VIEW_DETAIL_FIELDS,
    ]),
    runGhJson<Array<Record<string, unknown>>>([
      'api', `repos/${repo}/issues/${number}/comments?per_page=100`,
    ]).catch(() => [] as Array<Record<string, unknown>>),
  ]);

  const author = view.author as { login?: string; name?: string } | undefined;
  const reviewRequests = Array.isArray(view.reviewRequests) ? view.reviewRequests : [];
  const latestReviews = Array.isArray(view.latestReviews) ? view.latestReviews : [];
  const comments = Array.isArray(view.comments) ? view.comments : [];
  const checks = rollupChecks(view.statusCheckRollup as Array<Record<string, unknown>> | undefined);

  const commentSource: Array<Record<string, unknown>> =
    apiComments.length > 0 || comments.length === 0 ? apiComments : comments;

  // Conversation = issue comments + reviews that carry a body, oldest first.
  const commentThread: PullRequestComment[] = [
    ...commentSource.map((entry): PullRequestComment | null => {
      const record = entry as {
        author?: { login?: string };
        user?: { login?: string; avatar_url?: string };
        body?: string;
        createdAt?: string;
        created_at?: string;
        url?: string;
        html_url?: string;
      };
      if (!record.body?.trim()) return null;
      const login = record.user?.login || record.author?.login || 'unknown';
      return {
        author: login.replace(/\[bot\]$/i, ''),
        avatarUrl: record.user?.avatar_url || undefined,
        body: record.body,
        createdAt: record.created_at || record.createdAt || '',
        url: record.html_url || record.url,
        kind: 'comment',
      };
    }),
    ...latestReviews.map((entry): PullRequestComment | null => {
      const record = entry as {
        author?: { login?: string };
        body?: string;
        state?: string;
        submittedAt?: string;
      };
      if (!record.body?.trim()) return null;
      return {
        author: record.author?.login || 'unknown',
        body: record.body,
        createdAt: record.submittedAt || '',
        kind: 'review',
        reviewState: record.state || undefined,
      };
    }),
  ]
    .filter((entry): entry is PullRequestComment => Boolean(entry))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const detail: PullRequestDetail = {
    id: key,
    repo,
    number,
    title: typeof view.title === 'string' ? view.title : `#${number}`,
    author: author?.login || '',
    authorName: author?.name || undefined,
    isDraft: Boolean(view.isDraft),
    state: (typeof view.state === 'string' ? view.state : 'OPEN') as PullRequestDetail['state'],
    createdAt: typeof view.createdAt === 'string' ? view.createdAt : '',
    updatedAt: typeof view.updatedAt === 'string' ? view.updatedAt : '',
    url: typeof view.url === 'string' ? view.url : `https://github.com/${repo}/pull/${number}`,
    role: 'authored',
    headRefName: typeof view.headRefName === 'string' ? view.headRefName : undefined,
    baseRefName: typeof view.baseRefName === 'string' ? view.baseRefName : undefined,
    additions: typeof view.additions === 'number' ? view.additions : undefined,
    deletions: typeof view.deletions === 'number' ? view.deletions : undefined,
    body: typeof view.body === 'string' ? view.body : '',
    commentCount: comments.length,
    comments: commentThread,
    reviewers: [
      ...reviewRequests
        .map((entry) => String((entry as Record<string, unknown>).login || (entry as Record<string, unknown>).name || ''))
        .filter(Boolean)
        .map((login) => ({ login, state: 'REQUESTED' })),
      ...latestReviews
        .map((entry) => {
          const record = entry as { author?: { login?: string }; state?: string };
          return record.author?.login
            ? { login: record.author.login, state: String(record.state || '') }
            : null;
        })
        .filter((entry): entry is { login: string; state: string } => Boolean(entry)),
    ],
    checks,
    mergeable: typeof view.mergeable === 'string' ? view.mergeable : undefined,
  };

  detailCache.set(key, { fetchedAt: Date.now(), detail });
  return detail;
}

export async function getPullRequestDiff(
  repo: string,
  number: number,
  forceReload = false
): Promise<{ diff: string }> {
  const key = prKey(repo, number);
  const cached = diffCache.get(key);
  if (!forceReload && cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
    return { diff: cached.diff };
  }
  const diff = await runGh(['pr', 'diff', String(number), '--repo', repo]);
  diffCache.set(key, { fetchedAt: Date.now(), diff });
  return { diff };
}

export async function getPullRequestCommits(
  repo: string,
  number: number,
  forceReload = false
): Promise<{ commits: PullRequestCommit[] }> {
  const key = prKey(repo, number);
  const cached = commitsCache.get(key);
  if (!forceReload && cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
    return { commits: cached.commits };
  }
  // REST endpoint: carries the mapped GitHub account (login + avatar_url)
  // per commit when the author email is linked; unlinked identities (e.g.
  // automation git users) come back with author: null, like on github.com.
  const raw = await runGhJson<Array<Record<string, unknown>>>([
    'api', `repos/${repo}/pulls/${number}/commits?per_page=100`,
  ]);
  const commits: PullRequestCommit[] = (Array.isArray(raw) ? raw : [])
    .map((entry): PullRequestCommit | null => {
      const record = entry as {
        sha?: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
        author?: { login?: string; avatar_url?: string } | null;
      };
      const message = record.commit?.message?.trim();
      if (!message) return null;
      const [headline, ...rest] = message.split('\n');
      return {
        oid: record.sha || '',
        messageHeadline: headline.trim(),
        messageBody: rest.join('\n').trim() || undefined,
        author: record.author?.login || record.commit?.author?.name || '',
        avatarUrl: record.author?.avatar_url || undefined,
        authoredDate: record.commit?.author?.date || '',
      };
    })
    .filter((entry): entry is PullRequestCommit => Boolean(entry));
  commitsCache.set(key, { fetchedAt: Date.now(), commits });
  return { commits };
}

export async function addPullRequestComment(input: {
  repo: string;
  number: number;
  body: string;
}): Promise<{ ok: boolean; message?: string }> {
  const body = input.body.trim();
  if (!body) {
    return { ok: false, message: 'Comment is empty.' };
  }
  try {
    await runGh([
      'pr', 'comment', String(input.number),
      '--repo', input.repo,
      '--body', body,
    ]);
    detailCache.delete(prKey(input.repo, input.number));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function mergePullRequest(input: {
  repo: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
}): Promise<{ ok: boolean; message?: string }> {
  try {
    await runGh([
      'pr', 'merge', String(input.number),
      '--repo', input.repo,
      `--${input.method}`,
    ]);
    detailCache.delete(prKey(input.repo, input.number));
    listCache = null;
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
