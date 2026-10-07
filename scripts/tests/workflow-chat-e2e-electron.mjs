// End-to-end: a real chat session hands "have another agent review your
// changes" to the workflow engine through the start_workflow app tool. Real
// main process, real agent logins, throwaway repository with an uncommitted
// change. Uses agent usage, so it is not part of `npm test`.
//
//   npm run transpile:electron && node scripts/tests/workflow-chat-e2e-electron.mjs [review|fix]
//
// review: the reviewer only reports; the outcome comes back to the chat.
// fix:    the chat fixes the reviewer's blocking findings itself, then the
//         reviewer re-reviews.
// WORKFLOW_CHAT_PROVIDER (default claude) is the chat's agent and
// WORKFLOW_CHAT_REVIEWER (default codex) the agent named in the request.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2] === 'fix' ? 'fix' : 'review';
const provider = process.env.WORKFLOW_CHAT_PROVIDER || 'claude';
const reviewer = process.env.WORKFLOW_CHAT_REVIEWER || 'codex';
const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aegis-workflow-chat-')));
const repo = path.join(tmp, 'repo');

await mkdir(path.join(repo, 'src'), { recursive: true });
await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'chat-e2e', private: true, scripts: { test: 'node test.js' } }, null, 2));
await writeFile(path.join(repo, 'src', 'math.js'), 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n');
await writeFile(path.join(repo, 'test.js'), "const assert = require('node:assert/strict');\nconst math = require('./src/math');\nassert.equal(math.add(2, 3), 5);\nconsole.log('ok');\n");
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'E2E');
git('add', '-A');
git('commit', '-qm', 'init');
// The "changes" the chat made: multiply with an obvious bug, uncommitted.
await writeFile(
  path.join(repo, 'src', 'math.js'),
  'function add(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add, multiply };\n',
);

const label = reviewer.charAt(0).toUpperCase() + reviewer.slice(1);
const prompt =
  mode === 'fix'
    ? `我刚在 src/math.js 里加了 multiply（还没提交）。让 ${label} review 一下你的改动，有阻塞问题你就修掉，再让它复审。`
    : `我刚在 src/math.js 里加了 multiply（还没提交）。让 ${label} review 一下你的改动，只要审查结果，先别改代码。`;

const appDir = path.join(tmp, 'app');
await mkdir(path.join(appDir, 'dist-react'), { recursive: true });
await writeFile(path.join(appDir, 'dist-react', 'index.html'), '<!doctype html><html><body>workflow chat e2e</body></html>');
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'workflow-chat-e2e', main: 'main.cjs' }));
await writeFile(
  path.join(appDir, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = ${JSON.stringify(root)};
const REPO = ${JSON.stringify(repo)};
app.setPath('userData', path.join(${JSON.stringify(tmp)}, 'profile'));
require(path.join(ROOT, 'dist-electron/electron/libs/shell-environment.js')).ensureShellEnvironment();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const FINISHED = new Set(['succeeded', 'completed_with_gaps', 'failed', 'cancelled']);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'dist-electron/electron/preload.cjs') } });
  await win.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  require(path.join(ROOT, 'dist-electron/electron/ipc-handlers.js')).setupIPCHandlers(win);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js('window.__events = []; window.electron.onServerEvent((e) => window.__events.push(e)); 0');
  const events = async () => js('window.__events.splice(0)');
  const log = [];
  let parent = null;
  let parentStatus = null;
  const userPrompts = [];
  const assistantTexts = [];
  const toolUses = [];
  const approvals = [];
  const absorb = (batch) => {
    for (const e of batch) {
      log.push(e);
      const p = e.payload || {};
      if (e.type === 'session.status') {
        if (!parent && p.cwd === REPO && p.title === 'chat') parent = p.sessionId;
        if (p.sessionId === parent) parentStatus = p.status;
      }
      if (!parent || p.sessionId !== parent) continue;
      // The user approves the chat's own tool prompts (e.g. git diff).
      if (e.type === 'permission.request') approvals.push(p);
      if (e.type === 'stream.user_prompt') userPrompts.push(p.prompt);
      if (e.type === 'stream.message' && p.message && p.message.type === 'assistant' && !p.message.streaming) {
        for (const b of (p.message.message && p.message.message.content) || []) {
          if (b.type === 'text' && b.text) assistantTexts.push(b.text);
          if (b.type === 'tool_use') {
            // Commands are recorded in full: running another agent's CLI instead of start_workflow is the failure to spot.
            const command = b.input && (b.input.command || b.input.cmd);
            toolUses.push(command ? b.name + ': ' + String(Array.isArray(command) ? command.join(' ') : command).slice(0, 160) : b.name);
          }
        }
      }
    }
  };
  await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'session.start', payload: {
    cwd: REPO, projectCwd: REPO, envMode: 'local', provider: ${JSON.stringify(provider)}, title: 'chat', skipTitleGeneration: true,
    prompt: ${JSON.stringify(prompt)}, claudeAccessMode: 'acceptEdits', codexPermissionMode: 'auto',
  } }) + '); 0');
  const deadline = Date.now() + 30 * 60_000;
  let run = null;
  let last = '';
  let reported = false;
  let idleChecks = 0;
  const runningWithSession = new Set();
  while (Date.now() < deadline) {
    await delay(3000);
    absorb(await events());
    for (const request of approvals.splice(0)) {
      console.log('[chat-e2e] approving', request.toolName);
      await js('window.electron.sendClientEvent(' + JSON.stringify({ type: 'permission.response', payload: {
        sessionId: request.sessionId, toolUseId: request.toolUseId, result: { behavior: 'allow', updatedInput: request.input, scope: 'once' } } }) + '); 0');
    }
    if (!run && parent) {
      const runs = await js('window.electron.workflows.list()');
      run = runs.find((r) => r.parent && r.parent.sessionId === parent) || null;
      if (run) console.log('[chat-e2e] workflow started from the chat:', run.id, 'tool_use', run.parent.toolUseId);
    }
    if (run) {
      run = await js('window.electron.workflows.get(' + JSON.stringify(run.id) + ')');
      const line = run.status + ' | ' + run.steps.map((s) => s.key + ':' + s.state + (s.verdict ? '(' + s.verdict + ')' : '')).join(', ');
      if (line !== last) { console.log('[chat-e2e]', line); last = line; }
      // A running agent step must already name its session so its lane can open it.
      for (const step of run.steps) {
        if (step.kind === 'agent' && step.state === 'running' && step.sessionId) runningWithSession.add(step.key);
      }
      if (run.status === 'awaiting_confirmation') {
        console.log('[chat-e2e] confirming plan:', JSON.stringify(run.confirmReasons));
        await js('window.electron.workflows.act(' + JSON.stringify({ type: 'confirm', runId: run.id, expectedRevision: run.revision }) + ')');
        continue;
      }
      if (run.status === 'needs_input' || run.status === 'interrupted') break;
      reported = userPrompts.some((p) => /^Workflow /.test(p) && /finished|failed/.test(p));
      if (FINISHED.has(run.status) && reported && parentStatus !== 'running') break;
    } else if (parent && parentStatus && parentStatus !== 'running') {
      idleChecks += 1;
      if (idleChecks > 5) {
        console.log('[chat-e2e] the chat turn ended without starting a workflow');
        break;
      }
    }
  }
  absorb(await events());
  const result = { mode: ${JSON.stringify(mode)}, parent, run, userPrompts, assistantTexts, toolUses, reported };
  fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(${JSON.stringify(tmp)}, 'events.json'), JSON.stringify(log, null, 2));
  console.log('[chat-e2e] running steps that already had a session:', JSON.stringify([...runningWithSession]));
  console.log('[chat-e2e] chat tool calls:', JSON.stringify(toolUses));
  console.log('[chat-e2e] chat prompts:', JSON.stringify(userPrompts));
  if (run) {
    console.log('[chat-e2e] final status:', run.status, '| members:', run.members.map((m) => m.key + '=' + m.agent + '/' + m.role).join(', '));
    console.log('[chat-e2e] spec steps:', JSON.stringify(run.spec && run.spec.steps.map((s) => ({ id: s.id, kind: s.kind, start: s.start, implementer: s.implementer, reviewers: s.reviewers, max: s.maxRepairRounds }))));
    if (run.needsInput) console.log('[chat-e2e] needs input:', JSON.stringify(run.needsInput));
    if (run.error) console.log('[chat-e2e] error:', run.error);
  }
  console.log('[chat-e2e] last chat reply:\\n' + (assistantTexts[assistantTexts.length - 1] || '(none)'));
  console.log('[chat-e2e] repo diff:\\n' + require('node:child_process').execFileSync('git', ['diff'], { cwd: REPO, encoding: 'utf8' }));
  const ok = Boolean(run) && FINISHED.has(run.status) && run.status !== 'failed' && run.status !== 'cancelled' && reported;
  app.exit(ok ? 0 : 1);
});
`,
);

const child = spawn(path.join(root, 'node_modules', '.bin', 'electron'), [appDir], { stdio: 'inherit', env: { ...process.env, AEGIS_E2E: '1' } });
child.on('exit', (code) => {
  console.log(`[chat-e2e] artifacts in ${tmp}`);
  process.exit(code ?? 1);
});
