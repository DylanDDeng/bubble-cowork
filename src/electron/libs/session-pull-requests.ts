import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AttachSessionPullRequestInput, SessionPullRequestView } from '../../shared/types';
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
