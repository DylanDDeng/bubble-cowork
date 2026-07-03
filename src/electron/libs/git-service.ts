import { execFile } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { promisify } from 'util';
import type { GitBranchInfo, GitWorktree } from '../../shared/types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

async function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) {
  return execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024 * 20,
  });
}

function sanitizeWorktreeName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/\.\.+/g, '.');
  return sanitized || `aegis-${Date.now()}`;
}

function sanitizePathSegment(value: string): string {
  return sanitizeWorktreeName(value).replace(/[\\/]+/g, '-');
}

export async function assertGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['rev-parse', '--git-dir'], 5000);
}

export async function getGitTopLevel(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel'], 5000);
  return stdout.trim() || cwd;
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, ['branch', '--show-current'], 5000);
  return stdout.trim() || null;
}

export async function getHeadCommit(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', 'HEAD'], 5000);
  return stdout.trim();
}

// Aegis 把 worktree 建在 <repoRoot>/.worktrees/ 之内；不写排除规则的话，
// 链接 worktree 会以 "?? .worktrees/" 永久出现在用户主工作区的 git status 里
// （污染 changes 视图、误触 dirty 检查，stash -u 对它无效）。
// 写 .git/info/exclude 而非用户的 .gitignore——排除规则属于本机工具，不该进版本库。
export async function ensureWorktreesExcluded(cwd: string): Promise<void> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--git-common-dir'], 5000);
  const rawDir = stdout.trim();
  if (!rawDir) return;
  const repoRoot = await getGitTopLevel(cwd);
  const gitCommonDir = isAbsolute(rawDir) ? rawDir : join(repoRoot, rawDir);
  const excludePath = join(gitCommonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = readFileSync(excludePath, 'utf8');
  } catch {
    // 文件不存在则创建
  }
  const hasRule = existing
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return trimmed === '.worktrees/' || trimmed === '.worktrees' || trimmed === '/.worktrees/';
    });
  if (hasRule) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(excludePath, `${prefix}# Aegis worktrees (auto-added)\n.worktrees/\n`, 'utf8');
}

export async function hasDirtyWorkingTree(cwd: string): Promise<boolean> {
  await assertGitRepo(cwd);
  const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 30_000);
  return stdout.trim().length > 0;
}

async function getLatestStashSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash'], 5000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function stashWorkingTree(input: {
  cwd: string;
  message: string;
}): Promise<{ created: boolean; stashSha: string | null; output: string }> {
  if (!(await hasDirtyWorkingTree(input.cwd))) {
    return { created: false, stashSha: null, output: '' };
  }
  const beforeSha = await getLatestStashSha(input.cwd);
  const { stdout, stderr } = await runGit(
    input.cwd,
    ['stash', 'push', '--include-untracked', '-m', input.message],
    120_000
  );
  const afterSha = await getLatestStashSha(input.cwd);
  return {
    created: Boolean(afterSha && afterSha !== beforeSha),
    stashSha: afterSha,
    output: `${stdout || ''}${stderr || ''}`.trim(),
  };
}

async function findStashSelectorBySha(cwd: string, stashSha: string): Promise<string | null> {
  const { stdout } = await runGit(cwd, ['stash', 'list', '--format=%H%x00%gd'], 5000);
  for (const line of stdout.split('\n')) {
    const [sha, selector] = line.split('\0');
    if (sha === stashSha && selector) {
      return selector;
    }
  }
  return null;
}

export async function applyStash(input: {
  cwd: string;
  stashSha: string;
  drop?: boolean;
}): Promise<string> {
  const applied = await runGit(input.cwd, ['stash', 'apply', input.stashSha], 120_000);
  let output = `${applied.stdout || ''}${applied.stderr || ''}`.trim();
  if (input.drop) {
    const selector = await findStashSelectorBySha(input.cwd, input.stashSha);
    if (selector) {
      const dropped = await runGit(input.cwd, ['stash', 'drop', selector], 30_000);
      output = `${output}\n${dropped.stdout || ''}${dropped.stderr || ''}`.trim();
    }
  }
  return output;
}

export async function dropStash(input: {
  cwd: string;
  stashSha: string;
}): Promise<string> {
  const selector = await findStashSelectorBySha(input.cwd, input.stashSha);
  if (!selector) {
    return '';
  }
  const { stdout, stderr } = await runGit(input.cwd, ['stash', 'drop', selector], 30_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}

export async function listWorktrees(cwd: string): Promise<GitWorktree[]> {
  const repoRoot = await getGitTopLevel(cwd);
  const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  const records = stdout.split(/\n(?=worktree )/).map((item) => item.trim()).filter(Boolean);

  return records.map((record) => {
    const lines = record.split('\n');
    const result: GitWorktree = {
      path: '',
      branch: null,
      head: null,
      detached: false,
      locked: false,
      prunable: false,
      current: false,
    };

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        result.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        result.head = line.slice('HEAD '.length).trim() || null;
      } else if (line.startsWith('branch ')) {
        result.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || null;
      } else if (line === 'detached') {
        result.detached = true;
      } else if (line.startsWith('locked')) {
        result.locked = true;
      } else if (line.startsWith('prunable')) {
        result.prunable = true;
      }
    }

    result.current = result.path === repoRoot;
    return result;
  });
}

export async function getWorktreeBranchMap(cwd: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const worktrees = await listWorktrees(cwd).catch(() => []);
  for (const worktree of worktrees) {
    if (worktree.branch) {
      map.set(worktree.branch, worktree.path);
    }
  }
  return map;
}

export async function listBranches(cwd: string): Promise<{
  detachedHead: boolean;
  headShortHash: string | null;
  entries: GitBranchInfo[];
}> {
  await assertGitRepo(cwd);
  const worktreeMap = await getWorktreeBranchMap(cwd);
  const { stdout } = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
  ]);

  const entries: GitBranchInfo[] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fullRef = '', shortName = '', head = '', upstream = '', shortHash = ''] = line.split('\0');
      const remote = fullRef.startsWith('refs/remotes/');
      const name = remote ? shortName.replace(/^origin\//, '') : shortName;
      return {
        name,
        fullRef,
        current: head === '*',
        remote,
        upstream: upstream || null,
        shortHash,
        worktreePath: !remote ? worktreeMap.get(name) ?? null : null,
      };
    })
    .filter((entry) => entry.name && entry.fullRef !== 'refs/remotes/origin/HEAD');

  let headShortHash: string | null = null;
  const detachedHead = !entries.some((entry) => entry.current);
  if (detachedHead) {
    try {
      const { stdout: headStdout } = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], 5000);
      headShortHash = headStdout.trim() || null;
    } catch {
      headShortHash = null;
    }
  }

  return { detachedHead, headShortHash, entries };
}

export async function createWorktree(input: {
  cwd: string;
  branch: string;
  newBranch?: string | null;
  path?: string | null;
}): Promise<GitWorktree> {
  await assertGitRepo(input.cwd);
  const repoRoot = await getGitTopLevel(input.cwd);
  const branch = sanitizeWorktreeName(input.branch);
  const newBranch = input.newBranch ? sanitizeWorktreeName(input.newBranch) : null;
  const worktreePath =
    input.path?.trim() ||
    join(repoRoot, '.worktrees', sanitizePathSegment(newBranch || branch));
  mkdirSync(dirname(worktreePath), { recursive: true });
  const args = newBranch
    ? ['worktree', 'add', '-b', newBranch, worktreePath, branch]
    : ['worktree', 'add', worktreePath, branch];
  await runGit(input.cwd, args, 120_000);
  return {
    path: worktreePath,
    branch: newBranch || branch,
    head: null,
    detached: false,
    locked: false,
    prunable: false,
    current: false,
  };
}

export async function removeWorktree(input: {
  cwd: string;
  path: string;
  force?: boolean;
}): Promise<void> {
  const args = ['worktree', 'remove'];
  if (input.force) args.push('--force');
  args.push(input.path);
  await runGit(input.cwd, args, 120_000);
}

export async function deleteBranch(input: {
  cwd: string;
  branch: string;
  force?: boolean;
}): Promise<void> {
  const args = ['branch', input.force ? '-D' : '-d', input.branch];
  await runGit(input.cwd, args, 30_000);
}

export async function checkoutBranch(input: {
  cwd: string;
  branch: string;
}): Promise<string> {
  const { stdout, stderr } = await runGit(input.cwd, ['checkout', input.branch], 120_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}

export async function createBranch(input: {
  cwd: string;
  branch: string;
}): Promise<string> {
  const branch = input.branch.trim();
  await runGit(input.cwd, ['check-ref-format', '--branch', branch], 5000);
  const { stdout, stderr } = await runGit(input.cwd, ['checkout', '-b', branch], 120_000);
  return `${stdout || ''}${stderr || ''}`.trim();
}
