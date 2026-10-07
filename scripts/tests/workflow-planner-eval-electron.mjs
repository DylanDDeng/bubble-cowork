// Planner offline evaluation (plan §3.3): typical requests, each with the
// properties a correct plan must have, planned "plan only" through the real
// main process with each planner provider. Nothing is implemented; only the
// planner sessions run. Reports a pass rate per planner.
//
//   npm run transpile:electron && node scripts/tests/workflow-planner-eval-electron.mjs [claude,codex]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const planners = (process.argv[2] || 'claude,codex').split(',').map((p) => p.trim()).filter(Boolean);
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-planner-eval-')));
const repo = path.join(tmp, 'repo');
await mkdir(repo, { recursive: true });
await writeFile(
  path.join(repo, 'package.json'),
  JSON.stringify({ name: 'eval', private: true, scripts: { test: 'node test.js', lint: 'eslint .' } }, null, 2),
);
await writeFile(path.join(repo, 'package-lock.json'), '{}');
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=e@example.com', '-c', 'user.name=E', 'commit', '-qm', 'init'], { cwd: repo });
const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>planner eval</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'planner-eval', main: 'main.cjs' }));

// Expectations are checked against the planned spec (tree form):
//   implementer: agent of the implementer member (null = none expected)
//   reviewers: agents that must review (subset match)
//   advisors: agents that must appear as advisors
//   unsupported: whether unsupported must be non-empty
//   checks: argv strings that must appear among check steps
//   ask: an ask step must exist
//   maxRepair: expected reviewLoop repair rounds
const CASES = [
  { prompt: '实现登录功能，Codex 写代码，Claude 检查安全，另一个 Codex 检查边界情况，有问题修复后再审查。', implementer: 'codex', reviewers: ['claude', 'codex'] },
  { prompt: 'Add pagination to the users API. Claude implements, Codex reviews. Run npm test.', implementer: 'claude', reviewers: ['codex'], checks: ['npm test'] },
  { prompt: '让 Kimi 先调查一下为什么启动慢，然后 Codex 优化，Claude 审查。', implementer: 'codex', reviewers: ['claude'], advisors: ['kimi'] },
  { prompt: 'Refactor the date utils. Codex writes it, Claude and Kimi both review, at most one repair round.', implementer: 'codex', reviewers: ['claude', 'kimi'], maxRepair: 1 },
  { prompt: '给 README 加安装说明，Claude 来写，完成后帮我提交并开 PR。', implementer: 'claude', unsupported: true },
  { prompt: '两个 Codex 同时分别实现前端和后端，互不等待。', unsupported: true },
  { prompt: 'Use Gemini to implement the export feature.', unsupported: true },
  { prompt: 'Fix the flaky test in auth.spec.ts. Only Claude, no review needed.', implementer: 'claude', reviewers: [] },
  { prompt: 'Have Claude and Codex each propose a design for the cache layer, then Claude picks the better one and Codex implements it.', implementer: 'codex', advisors: ['claude'] },
  { prompt: 'Codex 实现，Claude 审查，跑 npm run lint 和 npm test。', implementer: 'codex', reviewers: ['claude'], checks: ['npm test', 'npm run lint'] },
  { prompt: 'Write developer docs for the CLI flags.', implementer: 'any' },
  { prompt: 'Claude: review my current uncommitted changes for security issues. Do not change anything.', implementer: null, reviewers: ['claude'] },
  { prompt: 'Ask me which database to use first, then implement the storage layer with Codex.', implementer: 'codex', ask: true },
  { prompt: 'Codex implements the feature; if tests fail fix up to 3 times; Claude does the review.', implementer: 'codex', reviewers: ['claude'], maxRepair: 3 },
  { prompt: '实现暗色模式，Grok 写代码，Devin 审查。', implementer: 'grok', reviewers: ['devin'] },
];

function walk(steps, visit) {
  for (const step of steps) {
    visit(step);
    if (step.steps) walk(step.steps, visit);
    if (step.checks) walk(step.checks, visit);
  }
}

function score(c, view) {
  const problems = [];
  if (!view || view.status !== 'awaiting_confirmation' || !view.spec) {
    return [`no usable plan (${view?.status}${view?.error ? `: ${String(view.error).slice(0, 200)}` : ''})`];
  }
  const spec = view.spec;
  const byKey = new Map(spec.members.map((m) => [m.key, m]));
  const implementers = spec.members.filter((m) => m.role === 'implementer');
  if (c.implementer === null && implementers.length > 0) problems.push('unexpected implementer');
  if (c.implementer && c.implementer !== 'any' && implementers[0]?.agent !== c.implementer) {
    problems.push(`implementer ${implementers[0]?.agent ?? 'none'} ≠ ${c.implementer}`);
  }
  if (c.implementer === 'any' && implementers.length === 0) problems.push('no implementer');
  const reviewAgents = [];
  const advisorAgents = spec.members.filter((m) => m.role === 'advisor').map((m) => m.agent);
  const argvs = [];
  let ask = false;
  let maxRepair = null;
  walk(spec.steps, (step) => {
    if (step.kind === 'reviewLoop') {
      maxRepair = step.maxRepairRounds;
      for (const key of step.reviewers) reviewAgents.push(byKey.get(key)?.agent);
    }
    if (step.kind === 'agent' && step.output === 'review') reviewAgents.push(byKey.get(step.member)?.agent);
    if (step.kind === 'check') argvs.push(step.argv.join(' '));
    if (step.kind === 'ask') ask = true;
  });
  if (c.reviewers) {
    if (c.reviewers.length === 0 && reviewAgents.length > 0) problems.push('unexpected reviewers');
    for (const agent of c.reviewers) {
      const need = c.reviewers.filter((a) => a === agent).length;
      if (reviewAgents.filter((a) => a === agent).length < need) problems.push(`missing reviewer ${agent}`);
    }
  }
  for (const agent of c.advisors ?? []) if (!advisorAgents.includes(agent)) problems.push(`missing advisor ${agent}`);
  if (c.unsupported && spec.unsupported.length === 0) problems.push('unsupported not reported');
  for (const argv of c.checks ?? []) if (!argvs.includes(argv)) problems.push(`missing check "${argv}"`);
  if (c.ask && !ask) problems.push('missing ask step');
  if (c.maxRepair !== undefined && maxRepair !== c.maxRepair) problems.push(`repair rounds ${maxRepair} ≠ ${c.maxRepair}`);
  return problems;
}

const AVAILABLE = ['claude', 'codex', 'kimi', 'grok', 'devin', 'bubble', 'pi'];
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
const CASES = ${JSON.stringify(CASES)};
const PLANNERS = ${JSON.stringify(planners)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'dist-electron/electron/preload.cjs') } });
  await win.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  require(path.join(ROOT, 'dist-electron/electron/ipc-handlers.js')).setupIPCHandlers(win);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const out = [];
  for (const planner of PLANNERS) {
    for (let i = 0; i < CASES.length; i++) {
      const request = { requestId: 'eval-' + planner + '-' + i + '-' + Date.now(), goal: CASES[i].prompt, cwd: ${JSON.stringify(repo)},
        permissionModes: {}, availableAgents: ${JSON.stringify(AVAILABLE)}, plannerAgent: planner, planOnly: true };
      const started = await js('window.electron.workflows.start(' + JSON.stringify(request) + ')').catch((e) => ({ ok: false, error: String(e) }));
      let view = started.ok ? started.run : null;
      const deadline = Date.now() + 6 * 60_000;
      while (view && view.status === 'planning' && Date.now() < deadline) {
        await delay(2000);
        view = await js('window.electron.workflows.get(' + JSON.stringify(view.id) + ')');
      }
      out.push({ planner, index: i, view });
      console.log('[eval] ' + planner + ' #' + i + ' ' + (view ? view.status : 'start failed: ' + started.error));
      if (view && view.status !== 'planning') {
        await js('window.electron.workflows.act(' + JSON.stringify({ type: 'cancel', runId: view.id, expectedRevision: view.revision }) + ')').catch(() => {});
      }
    }
  }
  fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'eval-raw.json'), JSON.stringify(out));
  app.exit(0);
});
`,
);

const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [appDir], { stdio: 'inherit' });
await new Promise((resolve) => child.on('exit', resolve));
const { readFile } = await import('node:fs/promises');
const raw = JSON.parse(await readFile(path.join(tmp, 'eval-raw.json'), 'utf8'));
const summary = {};
for (const entry of raw) {
  const problems = score(CASES[entry.index], entry.view);
  summary[entry.planner] ??= { pass: 0, total: 0, failures: [] };
  summary[entry.planner].total += 1;
  if (problems.length === 0) summary[entry.planner].pass += 1;
  else summary[entry.planner].failures.push({ case: entry.index, prompt: CASES[entry.index].prompt, problems });
}
for (const [planner, s] of Object.entries(summary)) {
  console.log(`\n[eval] ${planner}: ${s.pass}/${s.total} passed`);
  for (const f of s.failures) console.log(`  #${f.case} ${f.prompt}\n     ${f.problems.join('; ')}`);
}
await writeFile(path.join(tmp, 'eval-summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n[eval] details in ${tmp}`);
