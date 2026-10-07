// Strict workspace snapshots for workflows (plan §6.4–6.5). Unlike the
// per-turn snapshot helper, every failure is an error — a failed capture is
// never reported as "no changes" — and versions are retained under
// app-owned refs so review copies and diffs can be produced later.

import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class SnapshotError extends Error {
  constructor(
    readonly kind: 'not-git' | 'git-failed' | 'timeout' | 'io',
    message: string
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (e.killed) throw new SnapshotError('timeout', `git ${args[0]} timed out`);
    throw new SnapshotError('git-failed', `git ${args.join(' ')} failed: ${(e.stderr || e.message || '').trim()}`);
  }
}

export type RepoInfo = { root: string; relative: string };

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  let root: string;
  try {
    root = (await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 })).stdout.trim();
  } catch {
    throw new SnapshotError('not-git', `${cwd} is not inside a Git repository`);
  }
  const realRoot = await fs.realpath(root);
  const realCwd = await fs.realpath(cwd);
  return { root: realRoot, relative: path.relative(realRoot, realCwd) };
}

let counter = 0;

/**
 * Tree hash of the whole working tree (tracked + untracked, .gitignore
 * respected) without touching the repository's real index.
 */
export async function captureTree(cwd: string): Promise<string> {
  const { root } = await repoInfo(cwd);
  counter += 1;
  const indexFile = path.join(os.tmpdir(), `aegis-workflow-index-${process.pid}-${Date.now()}-${counter}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    try {
      await git(root, ['read-tree', 'HEAD'], { env });
    } catch {
      await git(root, ['read-tree', '--empty'], { env });
    }
    await git(root, ['add', '-A'], { env, timeout: 120_000 });
    const tree = (await git(root, ['write-tree'], { env })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new SnapshotError('git-failed', `unexpected tree id "${tree}"`);
    return tree;
  } finally {
    await fs.unlink(indexFile).catch(() => {});
  }
}

/**
 * Tree of the last commit, the base for reviewing changes that were made
 * before the workflow started ("review my uncommitted changes"). A repository
 * without commits yields the empty tree.
 */
export async function headTree(cwd: string): Promise<string> {
  const { root } = await repoInfo(cwd);
  try {
    return (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  } catch {
    counter += 1;
    const indexFile = path.join(os.tmpdir(), `aegis-workflow-index-${process.pid}-${Date.now()}-${counter}`);
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    try {
      await git(root, ['read-tree', '--empty'], { env });
      return (await git(root, ['write-tree'], { env })).trim();
    } finally {
      await fs.unlink(indexFile).catch(() => {});
    }
  }
}

/** Keep a tree reachable under refs/aegis/workflows/<runId>/<label> (never a user branch, never pushed). */
export async function retainTree(cwd: string, tree: string, runId: string, label: string): Promise<void> {
  const { root } = await repoInfo(cwd);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Aegis',
    GIT_AUTHOR_EMAIL: 'workflow@aegis.local',
    GIT_COMMITTER_NAME: 'Aegis',
    GIT_COMMITTER_EMAIL: 'workflow@aegis.local',
  };
  const commit = (await git(root, ['commit-tree', tree, '-m', `aegis workflow ${runId} ${label}`], { env })).trim();
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, '-');
  await git(root, ['update-ref', `refs/aegis/workflows/${runId}/${safeLabel}`, commit]);
}

export async function releaseRetainedTrees(cwd: string, runId: string): Promise<void> {
  const { root } = await repoInfo(cwd);
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', `refs/aegis/workflows/${runId}/`])).trim();
  for (const ref of refs.split('\n').filter(Boolean)) await git(root, ['update-ref', '-d', ref]);
}

/** Full unified diff between two trees, written to a file. Failure is an error, never an empty diff. */
export async function writeTreeDiff(
  cwd: string,
  from: string,
  to: string,
  outFile: string
): Promise<{ files: string[]; bytes: number }> {
  const { root } = await repoInfo(cwd);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const files =
    from === to
      ? []
      : (await git(root, ['-c', 'core.quotepath=false', 'diff', '--name-only', from, to])).split('\n').filter(Boolean);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outFile);
    const child = spawn('git', ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=5', from, to], {
      cwd: root,
    });
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => reject(new SnapshotError('git-failed', error.message)));
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolve();
        else reject(new SnapshotError('git-failed', `git diff exited ${code}: ${stderr.trim()}`));
      });
    });
  });
  const { size } = await fs.stat(outFile);
  return { files, bytes: size };
}

/**
 * Materialize a tree as a plain read-only directory (no .git, nothing
 * registered in the user's repository). Returns the directory matching the
 * original cwd inside the copy.
 */
export async function exportTree(cwd: string, tree: string, destDir: string): Promise<string> {
  const { root, relative } = await repoInfo(cwd);
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', tree], { cwd: root });
    const tar = spawn('tar', ['-x', '-f', '-', '-C', destDir]);
    let stderr = '';
    archive.stdout.pipe(tar.stdin);
    archive.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    tar.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    let archiveCode: number | null = null;
    archive.on('close', (code) => {
      archiveCode = code;
    });
    archive.on('error', (error) => reject(new SnapshotError('git-failed', error.message)));
    tar.on('error', (error) => reject(new SnapshotError('io', error.message)));
    tar.on('close', (code) => {
      if (code === 0 && archiveCode !== null && archiveCode !== 0) {
        reject(new SnapshotError('git-failed', `git archive exited ${archiveCode}: ${stderr.trim()}`));
      } else if (code === 0) resolve();
      else reject(new SnapshotError('io', `tar exited ${code}: ${stderr.trim()}`));
    });
  });
  await execFileAsync('chmod', ['-R', 'a-w', destDir]).catch((error) => {
    throw new SnapshotError('io', `could not make the review copy read-only: ${error.message}`);
  });
  return relative ? path.join(destDir, relative) : destDir;
}

export async function removeExport(destDir: string): Promise<void> {
  await execFileAsync('chmod', ['-R', 'u+w', destDir]).catch(() => {});
  await fs.rm(destDir, { recursive: true, force: true });
}

/** Content fingerprint of a directory, used to detect writes into a review copy. */
export async function fingerprintDirectory(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string) => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) hash.update(`->${await fs.readlink(full)}`);
      else if (entry.isFile()) hash.update(await fs.readFile(full));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

/** Inputs a Git tree cannot cover; acceptance that depends on them is never automatic (plan §6.4). */
export async function coverageGaps(cwd: string): Promise<string[]> {
  const { root } = await repoInfo(cwd);
  const gaps: string[] = [];
  if (await fs.stat(path.join(root, '.gitmodules')).catch(() => null)) gaps.push('submodules');
  const attributes = await fs.readFile(path.join(root, '.gitattributes'), 'utf8').catch(() => '');
  if (/filter=lfs/.test(attributes)) gaps.push('git-lfs');
  return gaps;
}
