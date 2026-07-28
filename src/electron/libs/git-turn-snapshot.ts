import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// Per-turn patches should stay small — they are persisted into the session
// transcript and shipped to the renderer.
const TURN_PATCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TURN_PATCH_MAX_CHARS = 2 * 1024 * 1024;

let snapshotCounter = 0;

export interface TurnTreeDiff {
  patch: string;
  truncated: boolean;
}

/**
 * Captures the full working-tree state (tracked + untracked, .gitignore
 * respected) as a git tree hash, WITHOUT touching the repository's real
 * index: all index operations run against a throwaway GIT_INDEX_FILE.
 * Returns null when cwd is not inside a git repo or git fails.
 */
export async function captureGitTreeSnapshot(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  snapshotCounter += 1;
  const indexFile = path.join(
    os.tmpdir(),
    `aegis-turn-index-${process.pid}-${Date.now()}-${snapshotCounter}`
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, env, timeout: 5000 });
    // Seed the temp index from HEAD; a repo with no commits yet starts empty.
    try {
      await execFileAsync('git', ['read-tree', 'HEAD'], { cwd, env, timeout: 10000 });
    } catch {
      await execFileAsync('git', ['read-tree', '--empty'], { cwd, env, timeout: 10000 });
    }
    await execFileAsync('git', ['add', '-A'], { cwd, env, timeout: 30000 });
    const { stdout } = await execFileAsync('git', ['write-tree'], { cwd, env, timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    void fs.unlink(indexFile).catch(() => {});
  }
}

/**
 * Unified diff between two tree snapshots produced by
 * captureGitTreeSnapshot. Tree-to-tree diff covers modified, deleted and
 * (because the snapshots `git add -A`) newly created untracked files alike.
 */
export async function diffGitTreeSnapshots(
  cwd: string,
  beforeTree: string,
  afterTree: string
): Promise<TurnTreeDiff> {
  if (beforeTree === afterTree) {
    return { patch: '', truncated: false };
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        beforeTree,
        afterTree,
      ],
      { cwd, timeout: 15000, maxBuffer: TURN_PATCH_MAX_BUFFER_BYTES }
    );
    const truncated = stdout.length > TURN_PATCH_MAX_CHARS;
    return {
      patch: truncated ? stdout.slice(0, TURN_PATCH_MAX_CHARS) : stdout,
      truncated,
    };
  } catch {
    return { patch: '', truncated: false };
  }
}
