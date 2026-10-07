// End-to-end workflow run through the real main process: real IPC handlers,
// real member sessions (real Claude / Codex logins), real Git snapshots and a
// real check command, against a throwaway repository. Uses agent usage, so it
// is not part of `npm test`.
//
//   npm run transpile:electron && node scripts/tests/workflow-e2e-electron.mjs [template|planner]
//
// WORKFLOW_E2E_IMPLEMENTER / WORKFLOW_E2E_REVIEWER pick the agents (default
// codex / claude). The final run view is written to <tmp>/result.json.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2] === 'planner' ? 'planner' : 'template';
const implementer = process.env.WORKFLOW_E2E_IMPLEMENTER || 'codex';
const reviewer = process.env.WORKFLOW_E2E_REVIEWER || 'claude';
// Real path: macOS tmpdir is a /var symlink to /private/var, and the IPC trust check compares real paths.
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-workflow-e2e-')));
const repo = path.join(tmp, 'repo');

await mkdir(path.join(repo, 'src'), { recursive: true });
await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'e2e', private: true, scripts: { test: 'node test.js' } }, null, 2));
await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'e2e', lockfileVersion: 3, requires: true, packages: {} }));
await writeFile(path.join(repo, 'src', 'math.js'), 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n');
await writeFile(
  path.join(repo, 'test.js'),
  "const assert = require('node:assert/strict');\nconst math = require('./src/math');\nassert.equal(math.add(2, 3), 5);\nconsole.log('ok');\n",
);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'E2E');
git('add', '-A');
git('commit', '-qm', 'init');

const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>workflow e2e</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'workflow-e2e', main: 'main.cjs' }));

const goal =
  'Add a function multiply(a, b) to src/math.js that returns the product of its arguments, export it next to add, ' +
  'and add assertions for it to test.js.';
const request =
  mode === 'template'
    ? {
        requestId: `e2e-${Date.now()}`,
        goal,
        cwd: repo,
        permissionModes: { codex: 'auto', claude: process.env.WORKFLOW_E2E_CLAUDE_MODE || 'acceptEdits' },
        availableAgents: [implementer, reviewer],
        template: { kind: 'implement-review', implementer, reviewers: [{ agent: reviewer, focus: 'correctness' }], checks: [['npm', 'test']], maxRepairRounds: 1 },
      }
    : {
        requestId: `e2e-${Date.now()}`,
        goal: `${goal} Use ${implementer} to write the code and have ${reviewer} review it; run npm test.`,
        cwd: repo,
        permissionModes: { codex: 'auto', claude: process.env.WORKFLOW_E2E_CLAUDE_MODE || 'acceptEdits' },
        availableAgents: [implementer, reviewer],
        plannerAgent: reviewer,
      };

await writeFile(
  path.join(appDir, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = ${JSON.stringify(root)};
app.setPath('userData', path.join(${JSON.stringify(tmp)}, 'profile'));
require(path.join(ROOT, 'dist-electron/electron/libs/shell-environment.js')).ensureShellEnvironment();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['succeeded', 'completed_with_gaps', 'failed', 'cancelled', 'needs_input', 'interrupted', 'awaiting_confirmation']);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'dist-electron/electron/preload.cjs') } });
  await win.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  require(path.join(ROOT, 'dist-electron/electron/ipc-handlers.js')).setupIPCHandlers(win);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const started = await js('window.electron.workflows.start(' + JSON.stringify(${JSON.stringify(request)}) + ')').catch((error) => ({ ok: false, error: String(error) }));
  if (!started.ok) { console.error('start failed', started.error); app.exit(2); return; }
  const id = started.run.id;
  let view = started.run;
  let last = '';
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    await delay(3000);
    view = await js('window.electron.workflows.get(' + JSON.stringify(id) + ')');
    const line = view.status + ' | ' + view.steps.map((s) => s.key + ':' + s.state + (s.verdict ? '(' + s.verdict + ')' : '')).join(', ');
    if (line !== last) { console.log('[e2e]', line); last = line; }
    if (view.status === 'awaiting_confirmation') {
      console.log('[e2e] plan needs confirmation:', JSON.stringify(view.confirmReasons));
      const confirmed = await js('window.electron.workflows.act(' + JSON.stringify({ type: 'confirm', runId: id, expectedRevision: view.revision }) + ')');
      if (!confirmed.ok) { console.error('confirm failed', confirmed.error); break; }
      continue;
    }
    if (TERMINAL.has(view.status)) break;
  }
  fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'result.json'), JSON.stringify(view, null, 2));
  console.log('[e2e] final status:', view.status);
  console.log('[e2e] acceptance:', JSON.stringify(view.acceptance));
  if (view.needsInput) console.log('[e2e] needs input:', JSON.stringify(view.needsInput));
  if (view.error) console.log('[e2e] error:', view.error);
  console.log('[e2e] repo diff:\\n' + require('node:child_process').execFileSync('git', ['diff'], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' }));
  app.exit(view.status === 'succeeded' ? 0 : 1);
});
`,
);

const electron = path.join(root, 'node_modules', '.bin', 'electron');
const child = spawn(electron, [appDir], { stdio: 'inherit', env: { ...process.env, AEGIS_E2E: '1' } });
child.on('exit', (code) => {
  console.log(`[e2e] artifacts in ${tmp}`);
  process.exit(code ?? 1);
});
