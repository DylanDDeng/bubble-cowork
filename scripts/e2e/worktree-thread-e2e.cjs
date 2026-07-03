// End-to-end check for the session-first isolated-copy flow, inside a real
// Electron main process (better-sqlite3 needs Electron's ABI). No GUI, no LLM:
// assign an isolated worktree to a session, do "agent work" on disk, then
// verify both endings — apply (squash-merge staged into the project, worktree
// recycled, session back on the project) and discard (work gone, project
// untouched). Launched by scripts/verify-worktree-thread-e2e.mjs.

const { app } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-wt-e2e-userdata-'));
  app.setPath('userData', userData);

  const repoRoot = process.cwd();
  const sessions = require(path.join(repoRoot, 'dist-electron/electron/libs/session-store.js'));
  const worktreeThreads = require(
    path.join(repoRoot, 'dist-electron/electron/libs/worktree-threads.js')
  );

  sessions.initialize();

  // realpath: macOS 的 tmpdir 是 /private/var 的符号链接，git 返回解析后的路径
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-wt-e2e-repo-')));
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'e2e@aegis.local']);
  git(repo, ['config', 'user.name', 'Aegis E2E']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);

  const notRunning = () => false;

  // --- apply 路径 ---
  const session = sessions.createSession({
    title: 'isolated thread',
    cwd: repo,
    projectCwd: repo,
    provider: 'claude',
  });
  const assigned = await worktreeThreads.assignIsolatedWorkspace(session.id);
  assert(assigned.ok, `assign failed: ${assigned.message}`);
  let row = sessions.getSession(session.id);
  assert(row.env_mode === 'worktree' && row.worktree_path, 'session should be in worktree mode');
  assert(row.cwd === row.worktree_path, 'session cwd should point at the worktree');
  assert(git(repo, ['status', '--porcelain']).trim() === '', 'project polluted by .worktrees');
  console.log('[e2e] isolated copy assigned; project stays clean');

  fs.writeFileSync(path.join(row.worktree_path, 'agent-note.txt'), 'work\n');
  const applied = await worktreeThreads.applyIsolatedWorkspace(session.id, notRunning);
  assert(applied.ok, `apply failed: ${applied.message}`);
  assert(
    fs.readFileSync(path.join(repo, 'agent-note.txt'), 'utf8').includes('work'),
    'applied change missing from the project'
  );
  assert(
    git(repo, ['diff', '--cached', '--name-only']).includes('agent-note.txt'),
    'applied change should be staged for review'
  );
  assert(!git(repo, ['worktree', 'list', '--porcelain']).includes('.worktrees'), 'worktree not recycled');
  row = sessions.getSession(session.id);
  assert(row.env_mode !== 'worktree' && !row.worktree_path, 'session should be back on the project');
  assert(row.cwd === repo, 'session cwd should be back at the project root');
  console.log('[e2e] apply: staged in project, worktree recycled, session back home');
  git(repo, ['commit', '-m', 'apply isolated changes']);

  // --- discard 路径 ---
  const session2 = sessions.createSession({
    title: 'discarded thread',
    cwd: repo,
    projectCwd: repo,
    provider: 'claude',
  });
  const assigned2 = await worktreeThreads.assignIsolatedWorkspace(session2.id);
  assert(assigned2.ok, `second assign failed: ${assigned2.message}`);
  const row2 = sessions.getSession(session2.id);
  fs.writeFileSync(path.join(row2.worktree_path, 'scrap.txt'), 'scrap\n');
  const discarded = await worktreeThreads.discardIsolatedWorkspace(session2.id, notRunning);
  assert(discarded.ok, `discard failed: ${discarded.message}`);
  assert(!fs.existsSync(path.join(repo, 'scrap.txt')), 'discarded work leaked into the project');
  assert(git(repo, ['status', '--porcelain']).trim() === '', 'project should be untouched after discard');
  assert(!git(repo, ['worktree', 'list', '--porcelain']).includes('.worktrees'), 'discarded worktree not recycled');
  console.log('[e2e] discard: work gone, project untouched');

  // --- running gate ---
  const gated = await worktreeThreads.applyIsolatedWorkspace(session2.id, () => true);
  assert(!gated.ok, 'apply should be refused for a non-worktree/running session');
  console.log('[e2e] guards hold');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('[e2e] worktree-thread end-to-end: all checks passed');
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(`[e2e] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    app.exit(1);
  })
);
