import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AttachSessionPullRequestInput, GitPullRequestSummary, SessionPullRequestView } from '../../shared/types';
import * as sessions from './session-store';
import { getGitPullRequestInfo, parseGitHubRepoFromRemote } from './git-pull-requests';

const exec = promisify(execFile);

function getSession(sessionId: string) {
  const session = typeof sessionId === 'string' ? sessions.getSession(sessionId) : undefined;
  if (!session || session.hidden_from_threads) throw new Error('This task is no longer available.');
  return session;
}

function pullRequestUrl(url: string) {
  if (typeof url !== 'string') throw new Error('Invalid pull request URL.');
  const match = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/i);
  if (!match) throw new Error('Invalid GitHub pull request URL.');
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export async function listTaskPullRequests(sessionId: string, refresh = false): Promise<SessionPullRequestView[]> {
  getSession(sessionId);
  const items = sessions.listSessionPullRequests(sessionId);
  if (!refresh) return items.map(pr => ({ ...pr, lookupStatus: 'cached' }));
  const results = await Promise.all(items.map(async pr => {
    const result = await getGitPullRequestInfo({ cwd: undefined, branch: pr.url, originRepo: pullRequestUrl(pr.url) });
    // A removed worktree must not prevent refreshing an associated PR by URL.
    const samePr = result.pr?.url.toLowerCase() === pr.url.toLowerCase();
    return { ...pr, ...(samePr ? result.pr : null), lookupStatus: result.status === 'found' && !samePr ? 'unknown' as const : result.status };
  }));
  // Do not resurrect attachments removed while the network request was running.
  const current = sessions.listSessionPullRequests(sessionId);
  return results.filter(pr => current.some(item => item.url === pr.url && item.attachedAt === pr.attachedAt));
}

async function readEnvironment(cwd: string) {
  const read = async (args: string[]) => (await exec('git', args, { cwd, timeout: 5000 })).stdout.trim();
  const [repoRoot, headBranch, remote] = await Promise.all([
    read(['rev-parse', '--show-toplevel']),
    read(['rev-parse', '--abbrev-ref', 'HEAD']),
    read(['remote', 'get-url', 'origin']),
  ]);
  return { repoRoot, headBranch, originRepo: parseGitHubRepoFromRemote(remote) };
}

export async function attachTaskPullRequest(input: AttachSessionPullRequestInput) {
  if (!input || typeof input.cwd !== 'string' || typeof input.repoRoot !== 'string' || typeof input.headBranch !== 'string') {
    throw new Error('Invalid pull request association.');
  }
  const expected = pullRequestUrl(input.url);
  const sessionCwd = () => {
    const session = getSession(input.sessionId);
    if (session.conversation_scope === 'dm') throw new Error('This task has no project environment.');
    return session.worktree_path || session.cwd || session.project_cwd;
  };
  const verify = async () => {
    if (sessionCwd() !== input.cwd) throw new Error('Task workspace changed. Refresh and try again.');
    const env = await readEnvironment(input.cwd);
    if (env.repoRoot !== input.repoRoot || env.headBranch !== input.headBranch || env.headBranch === 'HEAD' ||
        env.originRepo?.owner.toLowerCase() !== expected.owner.toLowerCase() || env.originRepo.repo.toLowerCase() !== expected.repo.toLowerCase()) {
      throw new Error('Repository or branch changed. Refresh and try again.');
    }
    return env;
  };
  const env = await verify();
  // Resolve from the branch, never trust the renderer's PR title, state or URL.
  const found = await getGitPullRequestInfo({ cwd: input.cwd, branch: env.headBranch, originRepo: env.originRepo });
  if (!found.pr || found.pr.url.toLowerCase() !== input.url.toLowerCase()) {
    throw new Error('Could not verify this branch pull request. Refresh and try again.');
  }
  await verify();
  if (sessionCwd() !== input.cwd) throw new Error('Task workspace changed. Refresh and try again.');
  const pr = { ...found.pr, repoRoot: env.repoRoot, headBranch: env.headBranch, attachedAt: Date.now() };
  const created = sessions.attachSessionPullRequest(input.sessionId, pr);
  return { created, pr: sessions.listSessionPullRequests(input.sessionId).find(item => item.url === pr.url)! };
}

export function detachTaskPullRequest(sessionId: string, url: string, attachedAt: number) {
  getSession(sessionId);
  pullRequestUrl(url);
  if (!Number.isFinite(attachedAt)) throw new Error('Invalid association timestamp.');
  sessions.detachSessionPullRequest(sessionId, url, attachedAt);
}

const SIDEBAR_REFRESH_TTL_MS = 60_000;
const SIDEBAR_LOOKUP_CONCURRENCY = 4;
/** PRs found for live worktree branches that have no explicit association. */
let branchPullRequests: Record<string, GitPullRequestSummary> = {};
let sidebarRefreshedAt = 0;
let sidebarRefresh: Promise<void> | null = null;

function summary(pr: GitPullRequestSummary): GitPullRequestSummary {
  return { number: pr.number, title: pr.title, state: pr.state, url: pr.url };
}

async function eachLimited<T>(items: T[], run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(SIDEBAR_LOOKUP_CONCURRENCY, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { await run(item); } catch { /* one failed lookup must not blank the rest */ }
    }
  }));
}

async function refreshSidebarPullRequests() {
  const latest = new Map<string, ReturnType<typeof sessions.listAllSessionPullRequests>[number]['pr']>();
  for (const { sessionId, pr } of sessions.listAllSessionPullRequests()) latest.set(sessionId, pr);
  // Only an open PR can still change state; merged and closed are final.
  await eachLimited([...latest].filter(([, pr]) => pr.state === 'open'), async ([sessionId, pr]) => {
    const result = await getGitPullRequestInfo({ cwd: undefined, branch: pr.url, originRepo: pullRequestUrl(pr.url) });
    if (result.pr && result.pr.url.toLowerCase() === pr.url.toLowerCase() && result.pr.state !== pr.state) {
      sessions.updateSessionPullRequestState(sessionId, { ...pr, ...result.pr });
    }
  });
  // A worktree owns its branch, so a PR on that branch belongs to the session.
  const worktrees = sessions.listSessions().filter(row =>
    row.env_mode === 'worktree' && row.worktree_path && row.conversation_scope !== 'dm' && !latest.has(row.id));
  const found: Record<string, GitPullRequestSummary> = {};
  await eachLimited(worktrees, async row => {
    const env = await readEnvironment(row.worktree_path!);
    const result = await getGitPullRequestInfo({ cwd: row.worktree_path!, branch: env.headBranch, originRepo: env.originRepo });
    if (result.pr) found[row.id] = summary(result.pr);
  });
  branchPullRequests = found;
  sidebarRefreshedAt = Date.now();
}

/**
 * The PR each sidebar session is tied to: its latest explicit association,
 * else the PR open on its worktree branch. `refresh` re-checks GitHub at most
 * once a minute; without it only stored and cached answers are returned.
 */
export async function listSidebarPullRequests(refresh = false): Promise<Record<string, GitPullRequestSummary>> {
  if (refresh && Date.now() - sidebarRefreshedAt > SIDEBAR_REFRESH_TTL_MS) {
    sidebarRefresh ??= refreshSidebarPullRequests().finally(() => { sidebarRefresh = null; });
    await sidebarRefresh;
  }
  const result: Record<string, GitPullRequestSummary> = { ...branchPullRequests };
  for (const { sessionId, pr } of sessions.listAllSessionPullRequests()) result[sessionId] = summary(pr);
  return result;
}
