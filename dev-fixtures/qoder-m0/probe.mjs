/**
 * M0 protocol probe for @qoder-ai/qoder-agent-sdk (v1.0.15)
 * Auth: qodercliAuth() only (reuse local qodercli login state).
 * Each probe is isolated via try/catch; results printed as structured report.
 */
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PNG_PATH = path.join(PROBE_DIR, 'red-100x100.png');

const report = [];
const t0 = Date.now();

function summarize(msg) {
  let s = msg.type;
  if (msg.subtype) s += '.' + msg.subtype;
  return s;
}

function assistantText(msg) {
  if (msg.type !== 'assistant') return '';
  const blocks = msg.message?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Drain a Query, collecting evidence. Optional hooks:
 *  - onInit(q, initMsg): called once when system.init arrives
 *  - interruptAfterMs: call q.interrupt() after this delay
 */
async function drain(q, { onInit, interruptAfterMs } = {}) {
  const seq = [];
  const texts = [];
  const streamEvents = new Set();
  let init = null;
  let result = null;
  let permissionDenied = null;
  let interrupted = false;
  let timer = null;
  if (interruptAfterMs) {
    timer = setTimeout(() => {
      interrupted = true;
      q.interrupt().catch((e) => console.error('  [interrupt err]', e.message));
    }, interruptAfterMs);
  }
  try {
    for await (const msg of q) {
      seq.push(summarize(msg));
      if (msg.type === 'system' && msg.subtype === 'init') {
        init = msg;
        if (onInit) await onInit(q, msg);
      }
      if (msg.type === 'assistant') {
        const t = assistantText(msg);
        if (t) texts.push(t);
        if (msg.error) seq.push('assistant.error:' + msg.error);
      }
      if (msg.type === 'stream_event') {
        const et = msg.event?.type;
        if (et) streamEvents.add(et);
      }
      if (msg.type === 'system' && msg.subtype === 'permission_denied') {
        permissionDenied = { tool_name: msg.tool_name, message: msg.message };
      }
      if (msg.type === 'result') result = msg;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    seq,
    text: texts.join(' | ').slice(0, 300),
    streamEvents: [...streamEvents],
    sessionId: init?.session_id ?? result?.session_id ?? null,
    model: init?.model ?? null,
    cliVersion: init?.qodercli_version ?? null,
    protocolVersion: init?.protocol_version ?? null,
    result: result
      ? {
          subtype: result.subtype,
          is_error: result.is_error,
          num_turns: result.num_turns,
          duration_ms: result.duration_ms,
          stop_reason: result.stop_reason ?? null,
          usage: result.usage
            ? {
                input_tokens: result.usage.input_tokens,
                output_tokens: result.usage.output_tokens,
                cache_read_input_tokens: result.usage.cache_read_input_tokens,
                context_usage_ratio: result.usage.context_usage_ratio,
              }
            : null,
          modelUsage: result.modelUsage ? Object.keys(result.modelUsage) : null,
          total_cost_usd: result.total_cost_usd,
          permission_denials: result.permission_denials?.length ?? 0,
          errors: result.errors ?? undefined,
        }
      : null,
    permissionDenied,
    interrupted,
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
    report.push({ probe: name, status: 'PASS', durationMs: Date.now() - start, evidence });
    console.log(`PASS (${Date.now() - start}ms)`, JSON.stringify(evidence).slice(0, 600));
  } catch (e) {
    report.push({
      probe: name,
      status: 'FAIL',
      durationMs: Date.now() - start,
      error: e?.message ?? String(e),
    });
    console.log(`FAIL (${Date.now() - start}ms):`, e?.message ?? String(e));
  }
}

let auth;
try {
  auth = qodercliAuth();
  console.log('qodercliAuth() created:', JSON.stringify(auth));
} catch (e) {
  console.error('qodercliAuth() threw:', e.message);
  process.exit(1);
}

const base = { auth, cwd: PROBE_DIR, stderr: () => {} };
let p1SessionId = null;
let p5SessionId = null;

// ---------- P1: basic query ----------
await runProbe('P1 basic query', 120_000, async () => {
  const q = query({ prompt: 'Reply with exactly: OK', options: { ...base, maxTurns: 3 } });
  const ev = await drain(q);
  p1SessionId = ev.sessionId;
  if (!ev.result) throw new Error('no result message; seq=' + ev.seq.join(','));
  return ev;
});

// ---------- P2: streaming partial messages ----------
await runProbe('P2 includePartialMessages', 120_000, async () => {
  const q = query({
    prompt: 'Reply with exactly: STREAM',
    options: { ...base, maxTurns: 3, includePartialMessages: true },
  });
  const ev = await drain(q);
  if (ev.streamEvents.length === 0) throw new Error('no stream_event received; seq=' + ev.seq.join(','));
  return ev;
});

// ---------- P3: resume ----------
await runProbe('P3 resume session', 120_000, async () => {
  if (!p1SessionId) throw new Error('skipped: no P1 session_id');
  const q = query({
    prompt: 'What did I ask you to reply earlier? Answer in one word.',
    options: { ...base, maxTurns: 3, resume: p1SessionId },
  });
  const ev = await drain(q);
  return { ...ev, resumedFrom: p1SessionId, contextKept: /ok/i.test(ev.text) };
});

// ---------- P4: fork ----------
await runProbe('P4 fork session', 120_000, async () => {
  if (!p1SessionId) throw new Error('skipped: no P1 session_id');
  const q = query({
    prompt: 'Reply with exactly: FORK',
    options: { ...base, maxTurns: 3, resume: p1SessionId, forkSession: true },
  });
  const ev = await drain(q);
  return { ...ev, forkedFrom: p1SessionId, newSessionId: ev.sessionId, forked: ev.sessionId !== p1SessionId };
});

// ---------- P5: interrupt ----------
await runProbe('P5 interrupt', 120_000, async () => {
  const q = query({
    prompt: 'Count from 1 to 500, one number per line.',
    options: { ...base, includePartialMessages: true },
  });
  const start = Date.now();
  const ev = await drain(q, { interruptAfterMs: 2000 });
  p5SessionId = ev.sessionId;
  return {
    ...ev,
    streamEvents: ev.streamEvents,
    endedAfterMs: Date.now() - start,
    reached500: /\b500\b/.test(ev.text),
  };
});

// ---------- P5b: session continues after interrupt ----------
await runProbe('P5b continue after interrupt', 120_000, async () => {
  if (!p5SessionId) throw new Error('skipped: no P5 session_id');
  const q = query({
    prompt: 'Reply with exactly: ALIVE',
    options: { ...base, maxTurns: 3, resume: p5SessionId },
  });
  const ev = await drain(q);
  return { ...ev, resumedFrom: p5SessionId };
});

// ---------- P6a: canUseTool allow ----------
const p6prompt = 'Use the Bash tool to run exactly this command: echo hello';
const p6options = {
  ...base,
  maxTurns: 6,
  permissionMode: 'default',
  allowedTools: ['Read', 'Glob', 'Grep'], // Bash NOT pre-approved
};
await runProbe('P6a canUseTool allow', 150_000, async () => {
  const calls = [];
  const q = query({
    prompt: p6prompt,
    options: {
      ...p6options,
      canUseTool: async (toolName, input, opts) => {
        calls.push({ toolName, input, toolUseID: opts.toolUseID, blockedPath: opts.blockedPath ?? null });
        return { behavior: 'allow', toolUseID: opts.toolUseID };
      },
    },
  });
  const ev = await drain(q);
  if (calls.length === 0) throw new Error('canUseTool never called; seq=' + ev.seq.join(','));
  return { ...ev, canUseToolCalls: calls };
});

// ---------- P6b: canUseTool deny ----------
await runProbe('P6b canUseTool deny', 150_000, async () => {
  const calls = [];
  const q = query({
    prompt: p6prompt,
    options: {
      ...p6options,
      canUseTool: async (toolName, input, opts) => {
        calls.push({ toolName, input, toolUseID: opts.toolUseID });
        return { behavior: 'deny', message: 'denied by M0 probe', toolUseID: opts.toolUseID };
      },
    },
  });
  const ev = await drain(q);
  if (calls.length === 0) throw new Error('canUseTool never called; seq=' + ev.seq.join(','));
  return { ...ev, canUseToolCalls: calls };
});

// ---------- P7: getAvailableModels ----------
await runProbe('P7 getAvailableModels', 120_000, async () => {
  let models = null;
  let modelsErr = null;
  const q = query({ prompt: 'Reply with exactly: MODELS', options: { ...base, maxTurns: 2 } });
  const ev = await drain(q, {
    onInit: async (qq) => {
      try {
        models = await qq.getAvailableModels();
      } catch (e) {
        modelsErr = e.message;
      }
    },
  });
  if (modelsErr) throw new Error('getAvailableModels: ' + modelsErr);
  if (!models) throw new Error('getAvailableModels returned nothing (init never seen?)');
  return {
    sessionModel: ev.model,
    count: models.length,
    models: models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      isDefault: m.isDefault ?? false,
      isVl: m.isVl ?? false,
      source: m.source ?? 'system',
    })),
  };
});

// ---------- P8: image attachment ----------
await runProbe('P8 image block', 150_000, async () => {
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
  const q = query({ prompt: userMsgs(), options: { ...base, maxTurns: 3 } });
  const ev = await drain(q);
  return { ...ev, understood: /red/i.test(ev.text) };
});

// ---------- report ----------
console.log('\n\n########## M0 PROBE REPORT ##########');
for (const r of report) {
  console.log(`\n[${r.status}] ${r.probe} (${r.durationMs}ms)`);
  if (r.error) console.log('  error:', r.error);
  if (r.evidence) {
    const ev = r.evidence;
    if (ev.seq) console.log('  seq:', ev.seq.slice(0, 40).join(' → ') + (ev.seq.length > 40 ? ` … (+${ev.seq.length - 40})` : ''));
    if (ev.streamEvents?.length) console.log('  streamEvents:', ev.streamEvents.join(','));
    if (ev.sessionId) console.log('  session_id:', ev.sessionId);
    if (ev.model) console.log('  model:', ev.model, '| cli:', ev.cliVersion, '| protocol:', ev.protocolVersion);
    if (ev.result) console.log('  result:', JSON.stringify(ev.result));
    if (ev.text) console.log('  text:', ev.text.slice(0, 200));
    if (ev.canUseToolCalls) console.log('  canUseToolCalls:', JSON.stringify(ev.canUseToolCalls));
    if (ev.models) console.log('  models:', JSON.stringify(ev.models));
    if (ev.contextKept !== undefined) console.log('  contextKept:', ev.contextKept);
    if (ev.forked !== undefined) console.log('  forked:', ev.forked, '| new:', ev.newSessionId);
    if (ev.endedAfterMs !== undefined) console.log('  endedAfterMs:', ev.endedAfterMs, '| interrupted:', ev.interrupted, '| reached500:', ev.reached500);
    if (ev.understood !== undefined) console.log('  understood(red):', ev.understood);
    if (ev.permissionDenied) console.log('  permissionDenied:', JSON.stringify(ev.permissionDenied));
  }
}
console.log('\ntotal elapsed:', Date.now() - t0, 'ms');
writeFileSync(path.join(PROBE_DIR, 'probe-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
console.log('written: probe-report.json');
process.exit(0);
