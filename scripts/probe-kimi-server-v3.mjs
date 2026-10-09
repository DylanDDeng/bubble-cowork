#!/usr/bin/env node
/**
 * v3 probes for Kimi Code 2.x `kimi web`, through Aegis's own
 * KimiServerManager (its daemon spawn, token and WS): each check pins a
 * server fact the adapter relies on, so an all-✅ run means they still hold
 * (re-run after a Kimi upgrade). Submits tiny real prompts (costs tokens) in
 * a temp working directory, then stops the daemon it started. Run after
 * `npm run transpile:electron`.
 *
 *   node scripts/probe-kimi-server-v3.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { KimiServerManager } = require('../dist-electron/electron/libs/provider/kimi-server-manager.js');

const manager = new KimiServerManager();
const cwd = mkdtempSync(path.join(tmpdir(), 'aegis-kimi-probe-'));
const frames = new Map(); // sessionId -> frames[]
manager.on('session_event', ({ sessionId, frame }) => {
  if (!frames.has(sessionId)) frames.set(sessionId, []);
  frames.get(sessionId).push(frame);
});
const results = [];
function report(name, outcome, detail) {
  results.push({ name, outcome, detail });
  console.log(`${outcome === 'ok' ? '✅' : outcome === 'warn' ? '⚠️ ' : '❌'} ${name}: ${detail}`);
}
const typeOf = (frame) => frame?.type || frame?.event || frame?.payload?.type || '?';
const payloadOf = (frame) => frame?.payload ?? frame?.data ?? frame;
async function waitFor(sessionId, predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = (frames.get(sessionId) || []).find(predicate);
    if (hit) return hit;
    await delay(150);
  }
  throw new Error(`timed out (${ms}ms) waiting for ${label}`);
}
const errorText = (error) => (error && (error.code ? `${error.code} ` : '') + (error.message || String(error))).slice(0, 300);

const createdSessions = [];
const probeRoots = [cwd];
async function newSession() {
  const { id } = await manager.createSession(cwd);
  createdSessions.push(id);
  await manager.subscribeSession(id);
  return id;
}

try {
  await manager.ensureDaemon();
  const model = await manager.getDefaultModel();
  console.log(`daemon up; default model ${model}; cwd ${cwd}`);
  const submit = (sessionId, text, extra = {}) =>
    manager.submitPrompt(sessionId, { content: [{ type: 'text', text }], model, permission_mode: 'manual', ...extra });

  // P1: stopping with a queued prompt. `prompts/{id}:cancel` is gone in 2.x;
  // a session :abort alone lets the queued prompt start; a per-prompt
  // `prompts/{id}:abort` first keeps it from running.
  for (const variant of ['session-abort-only', 'prompt-abort-then-session-abort']) {
    try {
      const s = await newSession();
      await submit(s, 'Count from 1 to 40, one number per line, nothing else.');
      const queued = await submit(s, 'Reply with exactly the word ZEBRA and nothing else.');
      await delay(1500);
      if (variant !== 'session-abort-only') {
        try {
          await manager.request('POST', `/sessions/${s}/prompts/${queued.prompt_id}:cancel`);
          report('P1 prompts/{id}:cancel is gone', 'warn', 'accepted (route is back?)');
        } catch (error) {
          report('P1 prompts/{id}:cancel is gone', 'ok', errorText(error));
        }
        await manager.cancelPrompt(s, queued.prompt_id); // prompts/{id}:abort
      }
      await manager.abortSession(s);
      await delay(12000);
      const queuedEvents = (frames.get(s) || [])
        .filter((f) => /^prompt\./.test(typeOf(f)) && (payloadOf(f).promptId ?? payloadOf(f).prompt_id) === queued.prompt_id)
        .map(typeOf);
      const ran = queuedEvents.includes('prompt.started');
      const expectRun = variant === 'session-abort-only';
      report(`P1 ${variant}`, ran === expectRun ? 'ok' : 'fail', `queued prompt ${ran ? 'ran' : 'did not run'}: ${queuedEvents.join(', ')}`);
    } catch (error) {
      report(`P1 ${variant}`, 'fail', errorText(error));
    }
  }

  // P2: questions — event shape, Aegis's current answer body, the correct body, dismiss.
  try {
    const s = await newSession();
    await submit(s, 'Call the AskUserQuestion tool exactly once to ask me "Pick a color" with the options "Red" and "Blue". After my answer, reply with only the color I picked.');
    const asked = await waitFor(s, (f) => /question\.requested/.test(typeOf(f)), 90000, 'question.requested');
    const payload = payloadOf(asked);
    report('P2 question.requested shape', 'ok', `type=${typeOf(asked)} payload=${JSON.stringify(payload).slice(0, 600)}`);
    const questionId = payload.question_id || payload.id;
    const q0 = Array.isArray(payload.questions) ? payload.questions[0] : null;
    try {
      await manager.resolveQuestion(s, questionId, { selected_label: 'Red' });
      report('P2 legacy {selected_label} body is refused', 'warn', 'accepted');
    } catch (error) {
      report('P2 legacy {selected_label} body is refused', 'ok', errorText(error));
    }
    if (q0) {
      const red = (q0.options || []).find((o) => /red/i.test(o.label || '')) || (q0.options || [])[0];
      try {
        await manager.resolveQuestion(s, questionId, { answers: { [q0.id]: { kind: 'single', option_id: red.id } } });
        report('P2 answer {answers:{q:{kind,option_id}}}', 'ok', `accepted (${q0.id} -> ${red.id})`);
      } catch (error) {
        report('P2 answer {answers:{q:{kind,option_id}}}', 'fail', `rejected: ${errorText(error)}`);
      }
      const resolvedFrame = await waitFor(s, (f) => /question\.(answered|resolved)/.test(typeOf(f)), 15000, 'question answered/resolved').catch(() => null);
      report('P2 resolution event', resolvedFrame ? 'ok' : 'warn', resolvedFrame ? typeOf(resolvedFrame) : 'none seen');
      await waitFor(s, (f) => /turn\.ended/.test(typeOf(f)), 90000, 'turn.ended').catch(() => null);
    }
    // Dismiss: ask again and dismiss.
    await submit(s, 'Call the AskUserQuestion tool once more with the same question and options.');
    const asked2 = await waitFor(
      s,
      (f) => /question\.requested/.test(typeOf(f)) && (payloadOf(f).question_id || payloadOf(f).id) !== questionId,
      90000,
      'second question'
    );
    const q2 = payloadOf(asked2).question_id || payloadOf(asked2).id;
    try {
      const out = await manager.request('POST', `/sessions/${s}/questions/${q2}:dismiss`);
      report('P2 :dismiss answers 40909', 'warn', `returned 0: ${JSON.stringify(out).slice(0, 200)}`);
    } catch (error) {
      report('P2 :dismiss answers 40909', error?.code === 40909 ? 'ok' : 'fail', errorText(error));
    }
    await manager.abortSession(s).catch(() => {});
  } catch (error) {
    report('P2', 'fail', errorText(error));
  }

  // P3: tool.result error flag field name.
  try {
    const s = await newSession();
    await submit(s, `Use your file reading tool to read ${path.join(cwd, 'does-not-exist.txt')}. Then reply with only: DONE`, { permission_mode: 'auto' });
    const result = await waitFor(s, (f) => typeOf(f) === 'tool.result', 90000, 'tool.result');
    const p = payloadOf(result);
    const keys = Object.keys(p);
    report('P3 tool.result error field', 'ok', `keys=${keys.join(',')} isError=${p.isError} is_error=${p.is_error} error=${JSON.stringify(p.error)?.slice(0, 80)}`);
    await waitFor(s, (f) => /turn\.ended/.test(typeOf(f)), 90000, 'turn.ended').catch(() => null);
  } catch (error) {
    report('P3', 'fail', errorText(error));
  }

  // P4: manual compaction events.
  try {
    const s = await newSession();
    await submit(s, 'Reply with exactly: HELLO', { permission_mode: 'auto' });
    await waitFor(s, (f) => /turn\.ended/.test(typeOf(f)), 90000, 'turn.ended');
    const before = (frames.get(s) || []).length;
    await manager.compactSession(s);
    await waitFor(s, (f) => /compaction\.(completed|failed)|history_compacted/.test(typeOf(f)), 120000, 'compaction end').catch(() => null);
    await delay(1500);
    const types = [...new Set((frames.get(s) || []).slice(before).map(typeOf))];
    report('P4 manual compaction ends with compaction.completed', types.includes('compaction.completed') ? 'ok' : 'fail', types.join(', '));
  } catch (error) {
    report('P4', 'fail', errorText(error));
  }

  // P5: image by absolute path instead of inline base64.
  try {
    const s = await newSession();
    const png = path.join(cwd, 'red.png');
    // 8x8 solid red PNG.
    writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64'));
    const out = await manager.submitPrompt(s, {
      content: [
        { type: 'text', text: 'What single color fills this image? Answer with one word.' },
        { type: 'image', source: { kind: 'path', path: png } },
      ],
      model,
      permission_mode: 'auto',
    });
    await waitFor(s, (f) => /turn\.ended/.test(typeOf(f)), 90000, 'turn.ended');
    const text = (frames.get(s) || []).filter((f) => typeOf(f) === 'assistant.delta').map((f) => payloadOf(f).delta || payloadOf(f).text || '').join('');
    report('P5 image source kind:path', /red/i.test(text) ? 'ok' : 'warn', `status=${out.status} answer=${JSON.stringify(text.slice(0, 80))}`);
  } catch (error) {
    report('P5', 'fail', errorText(error));
  }

  // P6: skill listing for a cwd Kimi has no workspace for registers it.
  try {
    const root = mkdtempSync(path.join(tmpdir(), 'aegis-kimi-ws-'));
    probeRoots.push(root);
    const id = await manager.registerWorkspace(root);
    const again = await manager.registerWorkspace(root);
    const skills = await manager.listWorkspaceSkills(id);
    report('P6 POST /workspaces', id && id === again ? 'ok' : 'fail', `id=${id} idempotent=${id === again} skills=${skills.length}`);
  } catch (error) {
    report('P6', 'fail', errorText(error));
  }
} catch (error) {
  report('setup', 'fail', errorText(error));
} finally {
  // Leave the user's Kimi store as it was: archive the probe's sessions and
  // unregister its temp workspaces (neither deletes anything on disk).
  for (const id of createdSessions) await manager.archiveSession(id).catch(() => {});
  const workspaces = await manager.listWorkspaces().catch(() => []);
  for (const workspace of workspaces.filter((entry) => probeRoots.some((root) => entry.root === root || entry.root?.endsWith(path.basename(root))))) {
    await manager.request('DELETE', `/workspaces/${workspace.id}`).catch(() => {});
  }
  await manager.stop().catch(() => {});
  console.log('\nSUMMARY ' + JSON.stringify(results.map(({ name, outcome }) => [name, outcome])));
  process.exit(0);
}
