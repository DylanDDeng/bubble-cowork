// End-to-end fan-out verification, run inside a real Electron main process
// (node-pty + better-sqlite3 need Electron's ABI). No GUI, no LLM tokens:
// two custom (terminal) members run a deterministic shell command in isolated
// worktrees; we assert the full loop — start → parallel PTY runs → exit-code
// completion → group settles → diffstat sees the work → adopt squash-merges
// the winner into the main workspace and recycles all worktrees.
//
// Launched by scripts/verify-run-group-e2e.mjs against dist-electron output.

const { app } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fail(message) {
  console.error(`[e2e] FAIL: ${message}`);
  app.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(500);
  }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-userdata-'));
  app.setPath('userData', userData);

  const repoRoot = process.cwd();
  const sessions = require(path.join(repoRoot, 'dist-electron/electron/libs/session-store.js'));
  const { RunGroupService } = require(
    path.join(repoRoot, 'dist-electron/electron/libs/run-group-service.js')
  );

  sessions.initialize();

  // Scratch project repo
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-repo-'));
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'e2e@aegis.local']);
  git(repo, ['config', 'user.name', 'Aegis E2E']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);

  // Custom runtime: deterministic "agent" that writes its prompt to a file
  const runtime = sessions.upsertCustomRuntime({
    name: 'echo-agent',
    command: 'echo "$AEGIS_PROMPT" > agent-note.txt',
  });

  const events = [];
  const service = new RunGroupService(
    async () => null, // no builtin members in this test
    () => {},
    (group) => events.push(group.status)
  );
  service.reconcileOnBoot();

  // --- start: 2 custom members fan out in parallel worktrees ---
  const result = await service.start({
    projectCwd: repo,
    prompt: 'hello fan-out',
    variants: [{ provider: `custom:${runtime.id}` }, { provider: `custom:${runtime.id}` }],
  });
  assert(result.ok, `start failed: ${result.message}`);
  assert(result.members.length === 2, 'two members expected');
  assert(
    result.members.every((m) => m.phase === 'running' && m.terminalThreadId && m.worktreePath),
    'both custom members should be running in worktrees'
  );
  console.log('[e2e] fan-out started: 2 custom members in isolated worktrees');

  // Main workspace stays clean while worktrees exist (info/exclude hygiene)
  assert(git(repo, ['status', '--porcelain']).trim() === '', 'main workspace polluted by .worktrees');

  // --- completion: PTY exit codes settle the group ---
  const settled = await waitFor('group to settle', 30_000, async () => {
    const group = sessions.getRunGroup(result.groupId);
    return group && group.status !== 'running' ? group : null;
  });
  assert(settled.status === 'settled', `expected settled, got ${settled.status}`);
  assert(
    settled.members.every((m) => m.phase === 'done'),
    `all members done, got ${settled.members.map((m) => m.phase).join(',')}`
  );
  console.log('[e2e] group settled via PTY exit codes');

  // --- comparison: worktree-vs-ref diffstat sees the uncommitted work ---
  const summary = await service.summary(result.groupId);
  for (const member of summary.members) {
    assert(member.diffStat, 'member diffstat missing');
    assert(member.diffStat.untracked === 1, `expected 1 untracked file, got ${member.diffStat.untracked}`);
  }
  console.log('[e2e] diffstat sees each member’s work');

  // --- adopt: squash-merge winner into the main workspace staging area ---
  const adopt = await service.adopt(result.groupId, 0);
  assert(adopt.ok, `adopt failed: ${adopt.message}`);
  const noteBody = fs.readFileSync(path.join(repo, 'agent-note.txt'), 'utf8');
  assert(noteBody.includes('hello fan-out'), 'winner output not in main workspace');
  const staged = git(repo, ['diff', '--cached', '--name-only']);
  assert(staged.includes('agent-note.txt'), 'winner change should be staged for review');
  console.log('[e2e] adopt staged the winner’s work in the main workspace');

  // --- recycling: no worktrees left behind after adoption ---
  const worktrees = git(repo, ['worktree', 'list', '--porcelain']);
  assert(!worktrees.includes('.worktrees'), 'worktrees should be recycled after adopt');
  const adopted = sessions.getRunGroup(result.groupId);
  assert(adopted.status === 'adopted', 'group should be adopted');
  console.log('[e2e] all member worktrees recycled');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('[e2e] run-group end-to-end: all checks passed');
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  })
);
