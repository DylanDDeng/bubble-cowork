/**
 * M0 probe round 2b — follow-ups for failed/skipped probes in probe2.mjs.
 * Appends results to probe-report-2.json (never touches probe-report.json).
 *
 *  P5-fix2a/2b: string-prompt interrupt at first stream_event, step-labeled
 *               error capture + stderr, run twice to check flakiness.
 *  P6c-deny2  : forceful prompt so the model actually attempts Bash; deny and
 *               verify the command is blocked (no RM_OK side effect).
 *  P8b-off2   : image sent to 'lite' (only catalog entry without isVl) — negative control.
 */
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PNG_PATH = path.join(PROBE_DIR, 'red-100x100.png');
const REPORT_PATH = path.join(PROBE_DIR, 'probe-report-2.json');
const newEntries = [];
const t0 = Date.now();
const auth = qodercliAuth();

function makeHub(q) {
  const events = [];
  const waiters = [];
  let ended = false, endError = null;
  const consume = (async () => {
    try {
      for await (const m of q) {
        events.push({ t: Date.now(), m });
        const idx = events.length - 1;
        for (const w of [...waiters]) {
          let hit = false;
          try { hit = w.pred(m, idx); } catch { /* ignore */ }
          if (hit) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
        }
      }
    } catch (e) { endError = e?.message ?? String(e); }
    finally { ended = true; for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); } }
  })();
  return {
    events, consume,
    ended: () => ended, endError: () => endError,
    waitFor(pred, ms) {
      const i = events.findIndex((e, idx) => { try { return pred(e.m, idx); } catch { return false; } });
      if (i >= 0) return Promise.resolve(events[i].m);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); resolve(null);
        }, ms) };
        waiters.push(w);
      });
    },
    async waitEnd(ms) { const s = Date.now(); while (!ended && Date.now() - s < ms) await new Promise((r) => setTimeout(r, 100)); return ended; },
    compressedSeq() {
      const out = [];
      for (const e of events) {
        const s = e.m.type + (e.m.subtype ? '.' + e.m.subtype : '');
        if (out.length && out[out.length - 1][0] === s) out[out.length - 1][1]++;
        else out.push([s, 1]);
      }
      return out.map(([s, n]) => (n > 1 ? `${s}x${n}` : s)).join(' ');
    },
    texts() {
      return events.filter((e) => e.m.type === 'assistant')
        .map((e) => (e.m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''))
        .filter(Boolean).join(' | ').slice(0, 400);
    },
  };
}

async function runProbe(name, timeoutMs, fn) {
  const start = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    const evidence = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const status = evidence?.skipped ? 'SKIP' : 'PASS';
    newEntries.push({ probe: name, status, durationMs: Date.now() - start, evidence });
    console.log(`${status} (${Date.now() - start}ms)`);
  } catch (e) {
    newEntries.push({ probe: name, status: 'FAIL', durationMs: Date.now() - start, error: e?.message ?? String(e) });
    console.log(`FAIL (${Date.now() - start}ms):`, e?.message ?? String(e));
  }
}

// ---------- P5-fix2: instrumented string-prompt interrupt ----------
async function p5fix2(label) {
  const sb = [];
  const steps = [];
  const q = query({
    prompt: 'Count from 1 to 500, one number per line.',
    options: { auth, cwd: PROBE_DIR, includePartialMessages: true, stderr: (d) => sb.push(d) },
  });
  const hub = makeHub(q);
  const tStart = Date.now();
  const firstStream = await hub.waitFor((m) => m.type === 'stream_event', 60_000);
  steps.push({ step: 'firstStreamEvent', at: Date.now() - tStart, ok: !!firstStream, eventType: firstStream?.event?.type ?? null });
  if (!firstStream) throw new Error(label + ': no stream_event in 60s; seq=' + hub.compressedSeq());
  let interruptErr = null, interruptResolveMs = null;
  const tCall = Date.now();
  try {
    await q.interrupt();
    interruptResolveMs = Date.now() - tCall;
  } catch (e) {
    interruptErr = e?.message ?? String(e);
  }
  steps.push({ step: 'interrupt', at: Date.now() - tStart, resolveMs: interruptResolveMs, error: interruptErr });
  const result = await hub.waitFor((m) => m.type === 'result', 60_000);
  steps.push({ step: 'result', at: Date.now() - tStart, arrived: !!result, subtype: result?.subtype ?? null });
  await hub.waitEnd(15_000);
  return {
    steps,
    resultFull: result ?? null,
    interruptErr,
    eventsAtEnd: hub.compressedSeq().slice(0, 250),
    endError: hub.endError(),
    stderrTail: sb.join('').slice(-1200),
  };
}

await runProbe('P5-fix2a string-prompt interrupt@firstStream (run A)', 150_000, () => p5fix2('A'));
await runProbe('P5-fix2b string-prompt interrupt@firstStream (run B)', 150_000, () => p5fix2('B'));

// ---------- P6c-deny2: forceful prompt + deny ----------
await runProbe('P6c-deny2 forceful rm prompt, deny', 180_000, async () => {
  const sb = [];
  const calls = [];
  const q = query({
    prompt: 'You must run exactly this command with the Bash tool, do not reply with text and do not substitute another command: rm -rf /tmp/qoder-m0-nonexistent-scratch-dir && echo RM_OK',
    options: {
      auth, cwd: PROBE_DIR, maxTurns: 6, permissionMode: 'default',
      allowedTools: ['Read', 'Glob', 'Grep'],
      stderr: (d) => sb.push(d),
      canUseTool: async (toolName, input, o) => {
        calls.push({
          toolName, input, toolUseID: o.toolUseID,
          suggestions: o.suggestions ?? null, decisionReason: o.decisionReason ?? null,
          title: o.title ?? null, blockedPath: o.blockedPath ?? null,
        });
        return { behavior: 'deny', message: 'denied by M0 probe', toolUseID: o.toolUseID };
      },
    },
  });
  const hub = makeHub(q);
  const result = await hub.waitFor((m) => m.type === 'result', 120_000);
  await hub.waitEnd(15_000);
  const rmOkSeen = hub.events.some((e) => e.m.type === 'user' && JSON.stringify(e.m).includes('RM_OK'));
  const deniedMsgs = hub.events.filter((e) => e.m.type === 'system' && e.m.subtype === 'permission_denied').map((e) => e.m);
  return {
    canUseToolFired: calls.length > 0,
    canUseToolCalls: calls,
    commandExecuted: rmOkSeen,
    denyBlockedExecution: calls.length > 0 && !rmOkSeen,
    permissionDeniedMessages: deniedMsgs,
    resultPermissionDenials: result?.permission_denials ?? null,
    resultSubtype: result?.subtype ?? null,
    text: hub.texts(),
    seq: hub.compressedSeq().slice(0, 250),
    stderrTail: sb.join('').slice(-800),
  };
});

// ---------- P8b-off2: image to 'lite' (no isVl flag) ----------
await runProbe('P8b-off2 image to lite (no isVl)', 180_000, async () => {
  const sb = [];
  const b64 = readFileSync(PNG_PATH).toString('base64');
  async function* userMsgs() {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: 'What color is this image? Answer with one word.' },
        ],
      },
      parent_tool_use_id: null,
    };
  }
  const q = query({ prompt: userMsgs(), options: { auth, cwd: PROBE_DIR, model: 'lite', maxTurns: 3, stderr: (d) => sb.push(d) } });
  const hub = makeHub(q);
  const result = await hub.waitFor((m) => m.type === 'result', 120_000);
  await hub.waitEnd(15_000);
  return {
    model: 'lite',
    text: hub.texts(),
    understoodRed: /red/i.test(hub.texts()),
    resultSubtype: result?.subtype ?? null,
    resultErrors: result?.errors ?? null,
    resultIsError: result?.is_error ?? null,
    seq: hub.compressedSeq().slice(0, 250),
    stderrTail: sb.join('').slice(-800),
  };
});

// ---------- merge into probe-report-2.json ----------
const existing = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
existing.report.push(...newEntries);
existing.appendedAt = new Date().toISOString();
writeFileSync(REPORT_PATH, JSON.stringify(existing, null, 2));
console.log('\nappended', newEntries.length, 'entries to probe-report-2.json; total elapsed:', Date.now() - t0, 'ms');
process.exit(0);
