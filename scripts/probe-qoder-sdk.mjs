/**
 * scripts/probe-qoder-sdk.mjs — Qoder SDK upgrade canary (M0 probe suite).
 *
 * Usage:
 *   node scripts/probe-qoder-sdk.mjs            # default SDK resolution (bundled CLI)
 *   QODER_PROBE_EXECUTABLE=$(which qodercli) node scripts/probe-qoder-sdk.mjs
 *                                               # pin the machine qodercli (production path)
 *
 * The plan (docs/qoder-sdk-adapter-plan.md) requires running BOTH executable
 * paths after any SDK/CLI upgrade; QODER_PROBE_EXECUTABLE maps to the SDK's
 * QODERCLI_PATH resolution. Suite origin: dev-fixtures/qoder-m0/probe2.mjs.
 */
if (process.env.QODER_PROBE_EXECUTABLE) {
  process.env.QODERCLI_PATH = process.env.QODER_PROBE_EXECUTABLE;
  console.log(`[probe] pinned executable via QODERCLI_PATH=${process.env.QODERCLI_PATH}`);
}
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PNG_PATH = path.join(PROBE_DIR, 'red-100x100.png');
const report = [];
const t0 = Date.now();
let catalog = null; // filled by P7r, consumed by P10/P12/P8b

// ---------- helpers ----------
function makePushQueue() {
  const items = [];
  let waiter = null;
  let done = false;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (done) return;
        const r = await new Promise((res) => { waiter = res; });
        if (r.done) return;
        yield r.value;
      }
    },
  };
  return {
    iterable,
    push(item) {
      if (waiter) { const w = waiter; waiter = null; w({ value: item, done: false }); }
      else items.push(item);
    },
    end() {
      done = true;
      if (waiter) { const w = waiter; waiter = null; w({ done: true }); }
    },
  };
}

function userMsg(text, extra = {}) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...extra };
}

function summarize(m) { return m.type + (m.subtype ? '.' + m.subtype : ''); }

function makeHub(q) {
  const events = []; // {t, m}
  const waiters = [];
  let ended = false;
  let endError = null;
  const consume = (async () => {
    try {
      for await (const m of q) {
        events.push({ t: Date.now(), m });
        const idx = events.length - 1;
        for (const w of [...waiters]) {
          let hit = false;
          try { hit = w.pred(m, idx); } catch { /* ignore */ }
          if (hit) {
            waiters.splice(waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(m);
          }
        }
      }
    } catch (e) { endError = e?.message ?? String(e); }
    finally {
      ended = true;
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
    }
  })();
  return {
    events,
    consume,
    ended: () => ended,
    endError: () => endError,
    waitFor(pred, ms) {
      const i = events.findIndex((e, idx) => { try { return pred(e.m, idx); } catch { return false; } });
      if (i >= 0) return Promise.resolve(events[i].m);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) waiters.splice(k, 1);
          resolve(null);
        }, ms) };
        waiters.push(w);
      });
    },
    async waitEnd(ms) {
      const start = Date.now();
      while (!ended && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100));
      return ended;
    },
    compressedSeq() {
      const out = [];
      for (const e of events) {
        const s = summarize(e.m);
        if (out.length && out[out.length - 1][0] === s) out[out.length - 1][1]++;
        else out.push([s, 1]);
      }
      return out.map(([s, n]) => (n > 1 ? `${s}x${n}` : s)).join(' ');
    },
    sessionIds() { return [...new Set(events.map((e) => e.m.session_id).filter(Boolean))]; },
    resultCount() { return events.filter((e) => e.m.type === 'result').length; },
    textsInRange(fromIdx, toIdx) {
      return events.slice(fromIdx, toIdx + 1)
        .filter((e) => e.m.type === 'assistant')
        .map((e) => (e.m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''))
        .filter(Boolean).join(' | ').slice(0, 400);
    },
  };
}

function resultSlim(r) {
  if (!r) return null;
  return {
    subtype: r.subtype, is_error: r.is_error, num_turns: r.num_turns,
    duration_ms: r.duration_ms, stop_reason: r.stop_reason ?? null,
    usage: r.usage ?? null, modelUsage: r.modelUsage ?? null,
    total_cost_usd: r.total_cost_usd, permission_denials: r.permission_denials ?? [],
    errors: r.errors ?? undefined, terminal_reason: r.terminal_reason ?? undefined,
  };
}

function slimModels(models) {
  if (!models) return null;
  return models.map((m) => { const { description, ...rest } = m; return rest; });
}

const tail = (buf) => buf.join('').slice(-800);

async function runProbe(name, timeoutMs, fn) {
  const start = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    const evidence = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const status = evidence?.skipped ? 'SKIP' : 'PASS';
    report.push({ probe: name, status, durationMs: Date.now() - start, evidence });
    console.log(`${status} (${Date.now() - start}ms)`);
  } catch (e) {
    report.push({ probe: name, status: 'FAIL', durationMs: Date.now() - start, error: e?.message ?? String(e) });
    console.log(`FAIL (${Date.now() - start}ms):`, e?.message ?? String(e));
  }
}

const auth = qodercliAuth();
const mkOpts = (stderrBuf, extra = {}) => ({ auth, cwd: PROBE_DIR, stderr: (d) => stderrBuf.push(d), ...extra });

// ---------- P5-fix: interrupt timing ----------
await runProbe('P5-fix interrupt timing', 150_000, async () => {
  const sb = [];
  const q = query({ prompt: 'Count from 1 to 500, one number per line.', options: mkOpts(sb, { includePartialMessages: true }) });
  const hub = makeHub(q);
  const tStart = Date.now();
  const firstStream = await hub.waitFor((m) => m.type === 'stream_event', 60_000);
  if (!firstStream) throw new Error('no stream_event within 60s');
  const tFirstStream = Date.now() - tStart;
  const tCall = Date.now();
  await q.interrupt();
  const tResolved = Date.now();
  const result = await hub.waitFor((m) => m.type === 'result', 60_000);
  const tResult = Date.now();
  await hub.waitEnd(15_000);
  return {
    tFirstStreamMs: tFirstStream,
    interruptResolveMs: tResolved - tCall,
    resultAtMs: tResult - tStart,
    interruptToResultMs: result ? tResult - tResolved : null,
    resultArrived: !!result,
    resultFull: result ?? null,
    sessionIds: hub.sessionIds(),
    seq: hub.compressedSeq().slice(0, 200),
    endError: hub.endError(),
    stderrTail: tail(sb),
  };
});

// ---------- P6c: canUseTool with classifier-blocked command ----------
const P6_CMD = 'rm -rf /tmp/qoder-m0-nonexistent-scratch-dir && echo RM_OK';
const p6prompt = `Run this exact shell command with the Bash tool: ${P6_CMD} — the directory does not exist, it is a harmless no-op.`;

async function p6run(mode, useCallback, callbackBehavior) {
  const sb = [];
  const calls = [];
  const opts = mkOpts(sb, { maxTurns: 6, permissionMode: mode, allowedTools: ['Read', 'Glob', 'Grep'] });
  if (useCallback) {
    opts.canUseTool = async (toolName, input, o) => {
      calls.push({
        toolName, input,
        toolUseID: o.toolUseID, agentID: o.agentID ?? null,
        suggestions: o.suggestions ?? null, decisionReason: o.decisionReason ?? null,
        title: o.title ?? null, displayName: o.displayName ?? null,
        description: o.description ?? null, blockedPath: o.blockedPath ?? null,
      });
      return callbackBehavior === 'allow'
        ? { behavior: 'allow', toolUseID: o.toolUseID }
        : { behavior: 'deny', message: 'denied by M0 probe', toolUseID: o.toolUseID };
    };
  }
  const q = query({ prompt: p6prompt, options: opts });
  const hub = makeHub(q);
  const result = await hub.waitFor((m) => m.type === 'result', 120_000);
  await hub.waitEnd(15_000);
  const rmOkSeen = hub.events.some((e) => e.m.type === 'user' && JSON.stringify(e.m).includes('RM_OK'));
  const deniedMsgs = hub.events.filter((e) => e.m.type === 'system' && e.m.subtype === 'permission_denied').map((e) => e.m);
  return {
    mode,
    canUseToolCalls: calls,
    canUseToolFired: calls.length > 0,
    commandExecuted: rmOkSeen,
    permissionDeniedMessages: deniedMsgs,
    result: resultSlim(result),
    seq: hub.compressedSeq().slice(0, 200),
    stderrTail: tail(sb),
  };
}

await runProbe('P6c-allow canUseTool(rm) allow', 180_000, async () => {
  const ev = await p6run('default', true, 'allow');
  if (!ev.canUseToolFired) throw new Error('canUseTool still not fired for rm -rf; seq=' + ev.seq);
  return ev;
});

await runProbe('P6c-deny canUseTool(rm) deny', 180_000, async () => {
  const ev = await p6run('default', true, 'deny');
  if (!ev.canUseToolFired) throw new Error('canUseTool still not fired for rm -rf; seq=' + ev.seq);
  return ev;
});

await runProbe('P6c-auto permissionMode=auto (no callback)', 180_000, () => p6run('auto', false));
await runProbe('P6c-dontAsk permissionMode=dontAsk (no callback)', 180_000, () => p6run('dontAsk', false));

// ---------- P7r: getAvailableModels timing matrix ----------
await runProbe('P7r getAvailableModels timing', 240_000, async () => {
  const sb = [];
  const pq = makePushQueue();
  const q = query({ prompt: pq.iterable, options: mkOpts(sb) });
  const hub = makeHub(q);
  // (a) right after initializationResult()
  let initRes = null, initErr = null, modelsA = null, modelsAErr = null;
  try { initRes = await q.initializationResult(); } catch (e) { initErr = e?.message ?? String(e); }
  try { modelsA = await q.getAvailableModels({ fetchStrategy: 'live' }); } catch (e) { modelsAErr = e?.message ?? String(e); }
  // one turn so we can test (b) after first result
  pq.push(userMsg('Reply with exactly: M'));
  const r1 = await hub.waitFor((m) => m.type === 'result', 120_000);
  let modelsB = null, modelsBErr = null;
  try { modelsB = await q.getAvailableModels(); } catch (e) { modelsBErr = e?.message ?? String(e); }
  pq.end();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  await hub.waitEnd(15_000);
  catalog = modelsA ?? modelsB ?? (initRes?.models ?? null);
  return {
    initOk: !!initRes, initErr,
    initKeys: initRes ? Object.keys(initRes) : null,
    initHasModels: Array.isArray(initRes?.models), initModelsCount: initRes?.models?.length ?? null,
    initAccount: initRes?.account ?? null,
    modelsAErr, modelsACount: modelsA?.length ?? null, modelsA: slimModels(modelsA),
    modelsBErr, modelsBCount: modelsB?.length ?? null, modelsB: slimModels(modelsB),
    result1: resultSlim(r1),
    stderrTail: tail(sb),
  };
});

// ---------- P9: same-Query multi-turn ----------
await runProbe('P9 same-query multi-turn', 300_000, async () => {
  const sb = [];
  const pq = makePushQueue();
  const q = query({ prompt: pq.iterable, options: mkOpts(sb, { includePartialMessages: true }) });
  const hub = makeHub(q);
  pq.push(userMsg('Reply with exactly: TURN1'));
  const r1 = await hub.waitFor((m) => m.type === 'result', 120_000);
  if (!r1) throw new Error('no result for turn1; seq=' + hub.compressedSeq().slice(0, 200));
  const mark2 = hub.events.length;
  pq.push(userMsg('Reply with exactly: TURN2'));
  const r2 = await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark2, 120_000);
  if (!r2) throw new Error('no result for turn2; seq=' + hub.compressedSeq().slice(0, 200));
  const markEnd = hub.events.length;
  pq.end();
  const tClose = Date.now();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  const cleanEnd = await hub.waitEnd(20_000);
  const turn1Results = hub.events.slice(0, mark2).filter((e) => e.m.type === 'result').length;
  const turn2Results = hub.events.slice(mark2, markEnd).filter((e) => e.m.type === 'result').length;
  return {
    turn1Results, turn2Results,
    sessionIds: hub.sessionIds(),
    turn1Text: hub.textsInRange(0, mark2 - 1),
    turn2Text: hub.textsInRange(mark2, markEnd - 1),
    result1: resultSlim(r1), result2: resultSlim(r2),
    cleanEnd, closeMs: Date.now() - tClose, endError: hub.endError(),
    seq: hub.compressedSeq().slice(0, 300),
    stderrTail: tail(sb),
  };
});

// ---------- P9b: same-Query interrupt then continue ----------
await runProbe('P9b same-query interrupt+continue', 300_000, async () => {
  const sb = [];
  const pq = makePushQueue();
  const q = query({ prompt: pq.iterable, options: mkOpts(sb, { includePartialMessages: true }) });
  const hub = makeHub(q);
  pq.push(userMsg('Count from 1 to 300, one number per line.'));
  const firstStream = await hub.waitFor((m) => m.type === 'stream_event', 90_000);
  if (!firstStream) throw new Error('no stream_event; seq=' + hub.compressedSeq().slice(0, 200));
  const tCall = Date.now();
  await q.interrupt();
  const tResolved = Date.now();
  const r1 = await hub.waitFor((m) => m.type === 'result', 30_000); // spec: result or 30s timeout
  const tResult1 = r1 ? Date.now() : null;
  const mark2 = hub.events.length;
  pq.push(userMsg('Reply with exactly: AFTER_INTERRUPT'));
  const r2 = await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark2, 120_000);
  pq.end();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  await hub.waitEnd(20_000);
  return {
    interruptResolveMs: tResolved - tCall,
    resultAfterInterrupt: !!r1,
    interruptToResultMs: r1 ? tResult1 - tResolved : null,
    result1Full: r1 ?? null,
    turn2Text: r2 ? hub.textsInRange(mark2, hub.events.length - 1) : null,
    result2: resultSlim(r2),
    sameSession: hub.sessionIds().length === 1, sessionIds: hub.sessionIds(),
    endError: hub.endError(),
    seq: hub.compressedSeq().slice(0, 300),
    stderrTail: tail(sb),
  };
});

// ---------- P9c: mid-turn priority:'now' injection (observational) ----------
await runProbe('P9c mid-turn priority=now injection', 300_000, async () => {
  const sb = [];
  const pq = makePushQueue();
  const q = query({ prompt: pq.iterable, options: mkOpts(sb, { includePartialMessages: true }) });
  const hub = makeHub(q);
  pq.push(userMsg('Count from 1 to 300, one number per line.'));
  const firstStream = await hub.waitFor((m) => m.type === 'stream_event', 90_000);
  if (!firstStream) throw new Error('no stream_event; seq=' + hub.compressedSeq().slice(0, 200));
  const tInject = Date.now();
  pq.push(userMsg('Stop counting. Reply with exactly: STEER', { priority: 'now' }));
  // settle: wait until 2 results, or no events for 8s, or 150s cap
  const cap = Date.now() + 150_000;
  let lastEventAt = Date.now();
  let lastCount = 0;
  while (Date.now() < cap) {
    await new Promise((r) => setTimeout(r, 500));
    if (hub.events.length !== lastCount) { lastCount = hub.events.length; lastEventAt = Date.now(); }
    if (hub.resultCount() >= 2) break;
    if (Date.now() - lastEventAt > 8000 && hub.resultCount() >= 1) break;
  }
  const results = hub.events.filter((e) => e.m.type === 'result').map((e) => resultSlim(e.m));
  const allText = hub.textsInRange(0, hub.events.length - 1);
  const steerIdx = allText.indexOf('STEER');
  // crude: did counting stop near injection? count how many numbers appeared total
  const numbers = (allText.match(/\d+/g) || []).length;
  pq.end();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  await hub.waitEnd(20_000);
  return {
    results, resultCount: results.length,
    steerSeen: steerIdx >= 0,
    approxNumbersEmitted: numbers,
    sessionIds: hub.sessionIds(),
    endError: hub.endError(),
    seq: hub.compressedSeq().slice(0, 300),
    textSample: allText.slice(-400),
    stderrTail: tail(sb),
  };
});

// ---------- P10: setModel mid-session ----------
await runProbe('P10 setModel mid-session', 300_000, async () => {
  const named = catalog?.find((m) => m.value !== 'auto' && m.isEnabled !== false && !m.isDefault)?.value
    ?? catalog?.find((m) => m.value !== 'auto' && m.isEnabled !== false)?.value
    ?? null;
  if (!named) return { skipped: true, reason: 'no named model in catalog', catalog: slimModels(catalog) };
  const sb = [];
  const pq = makePushQueue();
  const q = query({ prompt: pq.iterable, options: mkOpts(sb) });
  const hub = makeHub(q);
  pq.push(userMsg('Reply with exactly: M1'));
  const r1 = await hub.waitFor((m) => m.type === 'result', 120_000);
  if (!r1) throw new Error('no result turn1');
  const mark2 = hub.events.length;
  let setModelErr = null;
  try { await q.setModel(named); } catch (e) { setModelErr = e?.message ?? String(e); }
  pq.push(userMsg('Reply with exactly: M2'));
  const r2 = await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark2, 120_000);
  const statusMsgs = hub.events.slice(mark2).filter((e) => e.m.type === 'system').map((e) => e.m);
  pq.end();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  await hub.waitEnd(20_000);
  const mu1 = r1?.modelUsage ? Object.keys(r1.modelUsage) : [];
  const mu2 = r2?.modelUsage ? Object.keys(r2.modelUsage) : [];
  return {
    switchedTo: named, setModelErr,
    turn1ModelUsageKeys: mu1, turn2ModelUsageKeys: mu2,
    modelChanged: JSON.stringify(mu1) !== JSON.stringify(mu2),
    systemMessagesAfterSwitch: statusMsgs.map((m) => ({ subtype: m.subtype, permissionMode: m.permissionMode, status: m.status })),
    result1: resultSlim(r1), result2: resultSlim(r2),
    sessionIds: hub.sessionIds(),
    stderrTail: tail(sb),
  };
});

// ---------- P11: setPermissionMode mid-session ----------
await runProbe('P11 setPermissionMode mid-session', 300_000, async () => {
  const planFile = path.join(PROBE_DIR, 'plan-test.txt');
  if (existsSync(planFile)) rmSync(planFile);
  const sb = [];
  const pq = makePushQueue();
  const canUseToolCalls = [];
  const q = query({
    prompt: pq.iterable,
    options: mkOpts(sb, {
      canUseTool: async (toolName, input, o) => {
        canUseToolCalls.push({ toolName, input, toolUseID: o.toolUseID });
        return { behavior: 'deny', message: 'denied by M0 probe (P11)', toolUseID: o.toolUseID };
      },
    }),
  });
  const hub = makeHub(q);
  pq.push(userMsg('Reply with exactly: PM1'));
  const r1 = await hub.waitFor((m) => m.type === 'result', 120_000);
  if (!r1) throw new Error('no result turn1');
  let setErr1 = null, setErr2 = null;
  try { await q.setPermissionMode('plan'); } catch (e) { setErr1 = e?.message ?? String(e); }
  const mark2 = hub.events.length;
  pq.push(userMsg('Create a file named plan-test.txt containing hello'));
  let r2 = await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark2, 120_000);
  let turn2TimedOut = false;
  if (!r2) { turn2TimedOut = true; await q.interrupt().catch(() => {}); await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark2, 15_000); }
  try { await q.setPermissionMode('default'); } catch (e) { setErr2 = e?.message ?? String(e); }
  const mark3 = hub.events.length;
  pq.push(userMsg('Reply with exactly: PM3'));
  const r3 = await hub.waitFor((m, idx) => m.type === 'result' && idx >= mark3, 120_000);
  pq.end();
  await q.close().catch((e) => sb.push('close err: ' + e.message));
  await hub.waitEnd(20_000);
  const fileCreated = existsSync(planFile);
  if (fileCreated) rmSync(planFile);
  const permModeMsgs = hub.events
    .filter((e) => (e.m.type === 'system' && (e.m.subtype === 'init' || e.m.subtype === 'status')) || e.m.type === 'result')
    .map((e) => ({ kind: summarize(e.m), permissionMode: e.m.permissionMode ?? null }));
  return {
    setErr1, setErr2, turn2TimedOut,
    fileCreatedInPlanMode: fileCreated,
    canUseToolCalls,
    turn2Text: hub.textsInRange(mark2, mark3 - 1),
    turn3Ok: !!r3 && !r3.is_error,
    permModeMsgs,
    sessionIds: hub.sessionIds(),
    seq: hub.compressedSeq().slice(0, 300),
    stderrTail: tail(sb),
  };
});

// ---------- P12: init/usage full mapping ----------
async function p12run(model) {
  const sb = [];
  const q = query({
    prompt: 'Reply with exactly: U',
    options: mkOpts(sb, { includePartialMessages: true, ...(model ? { model } : {}) }),
  });
  const hub = makeHub(q);
  const result = await hub.waitFor((m) => m.type === 'result', 120_000);
  await hub.waitEnd(15_000);
  const init = hub.events.find((e) => e.m.type === 'system' && e.m.subtype === 'init')?.m ?? null;
  const assistantUsages = hub.events
    .filter((e) => e.m.type === 'assistant')
    .map((e) => e.m.message?.usage ?? null);
  const streamUsages = hub.events
    .filter((e) => e.m.type === 'stream_event' && e.m.event?.usage)
    .map((e) => e.m.event.usage);
  return {
    model: model ?? '(default)',
    initFull: init,
    resultFull: result ?? null,
    assistantUsages,
    streamEventUsages: streamUsages.slice(0, 5),
    stderrTail: tail(sb),
  };
}

await runProbe('P12a init+usage full dump (default model)', 180_000, () => p12run(null));
await runProbe('P12b init+usage full dump (fixed named model)', 180_000, async () => {
  const named = catalog?.find((m) => m.value !== 'auto' && m.isEnabled !== false)?.value ?? null;
  if (!named) return { skipped: true, reason: 'no named model in catalog' };
  return p12run(named);
});

// ---------- P8b: image with isVl=false vs isVl=true ----------
async function p8run(modelValue) {
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
  const q = query({ prompt: userMsgs(), options: mkOpts(sb, { model: modelValue, maxTurns: 3 }) });
  const hub = makeHub(q);
  const result = await hub.waitFor((m) => m.type === 'result', 120_000);
  await hub.waitEnd(15_000);
  return {
    model: modelValue,
    text: hub.textsInRange(0, hub.events.length - 1),
    understoodRed: /red/i.test(hub.textsInRange(0, hub.events.length - 1)),
    result: resultSlim(result),
    seq: hub.compressedSeq().slice(0, 200),
    stderrTail: tail(sb),
  };
}

await runProbe('P8b-off image with isVl=false model', 180_000, async () => {
  const m = catalog?.find((x) => x.isVl === false && x.isEnabled !== false)?.value ?? null;
  if (!m) return { skipped: true, reason: 'no isVl=false model in catalog', catalog: slimModels(catalog) };
  return p8run(m);
});
await runProbe('P8b-on image with isVl=true model', 180_000, async () => {
  const m = catalog?.find((x) => x.isVl === true && x.isEnabled !== false)?.value ?? null;
  if (!m) return { skipped: true, reason: 'no isVl=true model in catalog', catalog: slimModels(catalog) };
  return p8run(m);
});

// ---------- write report ----------
console.log('\n\n########## M0 PROBE REPORT 2 ##########');
for (const r of report) {
  console.log(`[${r.status}] ${r.probe} (${r.durationMs}ms)${r.error ? ' error: ' + r.error : ''}`);
}
console.log('\ntotal elapsed:', Date.now() - t0, 'ms');
writeFileSync(path.join(PROBE_DIR, 'probe-report-2.json'), JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
console.log('written: probe-report-2.json');
process.exit(0);
